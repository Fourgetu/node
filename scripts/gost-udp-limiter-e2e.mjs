import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const gostBinary = process.env.GOST_BINARY_PATH ?? '/usr/local/bin/gost';
const upstreamPort = 39_810;
const datagramBytes = 1_000;
const measuredDatagrams = 400;
const routes = [
    { id: 'udp-route-a', port: 39_811, rate: 100_000 },
    { id: 'udp-route-b', port: 39_812, rate: 400_000 },
];

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'gost-udp-limiter-e2e-'));
let gostProcess;
const upstream = dgram.createSocket('udp4');

upstream.on('message', (message, remote) => {
    upstream.send(message, remote.port, remote.address);
});

const bind = (socket, port = 0) =>
    new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(port, '127.0.0.1', resolve);
    });

const roundTripSeries = async (port, count, timeoutMs = 10_000) => {
    const socket = dgram.createSocket('udp4');
    await bind(socket);
    const payload = Buffer.alloc(datagramBytes, 7);
    const startedAt = performance.now();

    try {
        for (let index = 0; index < count; index += 1) {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(
                    () => reject(new Error(`Timed out waiting for UDP route ${port}`)),
                    timeoutMs,
                );
                socket.once('message', (message) => {
                    clearTimeout(timeout);
                    if (message.length !== payload.length) {
                        reject(
                            new Error(
                                `Expected ${payload.length} bytes, received ${message.length}`,
                            ),
                        );
                        return;
                    }
                    resolve();
                });
                socket.send(payload, port, '127.0.0.1', (error) => {
                    if (error) {
                        clearTimeout(timeout);
                        reject(error);
                    }
                });
            });
        }
    } finally {
        socket.close();
    }

    return (performance.now() - startedAt) / 1_000;
};

const waitForUdpRoute = async (port) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try {
            await roundTripSeries(port, 1, 250);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error(`Timed out waiting for UDP route ${port}`);
};

const writeLimiter = (route, rate = route.rate) =>
    writeFile(path.join(temporaryDirectory, route.id), `$ ${rate}B ${rate}B\n`, 'utf8');

try {
    await bind(upstream, upstreamPort);
    await Promise.all(routes.map((route) => writeLimiter(route)));

    const config = {
        limiters: routes.map((route) => ({
            name: route.id,
            reload: '1s',
            file: { path: path.join(temporaryDirectory, route.id) },
        })),
        services: routes.map((route) => ({
            name: route.id,
            addr: `127.0.0.1:${route.port}`,
            limiter: route.id,
            handler: { type: 'udp' },
            listener: { type: 'udp' },
            forwarder: {
                nodes: [{ name: 'upstream', addr: `127.0.0.1:${upstreamPort}` }],
            },
        })),
    };
    const configPath = path.join(temporaryDirectory, 'config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    gostProcess = spawn(gostBinary, ['-C', configPath], {
        stdio: process.env.GOST_E2E_DEBUG ? 'inherit' : 'ignore',
    });
    await Promise.all(routes.map((route) => waitForUdpRoute(route.port)));

    // Empty the initial token buckets before comparing steady-state rates.
    await Promise.all(
        routes.map((route) => roundTripSeries(route.port, route.rate / datagramBytes)),
    );
    const [routeA, routeB] = await Promise.all(
        routes.map((route) => roundTripSeries(route.port, measuredDatagrams)),
    );

    await writeLimiter(routes[0], 200_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const routeAAfterUpdate = await roundTripSeries(routes[0].port, measuredDatagrams);

    if (routeA < routeB * 2.5) {
        throw new Error('Per-route UDP buckets were not independent enough');
    }
    if (routeAAfterUpdate >= routeA * 0.75) {
        throw new Error('Dynamic UDP limiter source update did not increase Route A throughput');
    }

    // oxlint-disable-next-line no-console -- this script emits machine-readable E2E metrics.
    console.log(
        JSON.stringify(
            {
                payloadBytes: datagramBytes * measuredDatagrams,
                concurrentRoundTripSeconds: { routeA, routeB },
                routeAAfterDynamicUpdateSeconds: routeAAfterUpdate,
            },
            null,
            2,
        ),
    );
} finally {
    gostProcess?.kill('SIGTERM');
    upstream.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
}
