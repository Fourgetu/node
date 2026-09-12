import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const gostBinary = process.env.GOST_BINARY_PATH ?? '/usr/local/bin/gost';
const payloadBytes = 1_000_000;
const upstreamPort = 39_800;
const routes = [
    { id: 'route-a', port: 39_801, rate: 250_000 },
    { id: 'route-b', port: 39_802, rate: 1_000_000 },
];

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'gost-limiter-e2e-'));
let gostProcess;

const upstream = net.createServer((socket) => {
    let operation;
    let uploaded = 0;

    socket.on('data', (chunk) => {
        if (!operation) {
            operation = String.fromCharCode(chunk[0]);
            chunk = chunk.subarray(1);
            if (operation === 'D') {
                socket.end(Buffer.alloc(payloadBytes, 7));
                return;
            }
        }

        if (operation === 'U') {
            uploaded += chunk.length;
            if (uploaded >= payloadBytes) socket.end('OK');
        }
    });
});

const listen = (server, port) =>
    new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });

const waitForPort = async (port) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        const ready = await new Promise((resolve) => {
            const socket = net.connect(port, '127.0.0.1');
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => resolve(false));
        });
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for TCP port ${port}`);
};

const transfer = (port, operation) =>
    new Promise((resolve, reject) => {
        const startedAt = performance.now();
        let downloaded = 0;
        const socket = net.connect(port, '127.0.0.1');

        socket.once('connect', () => {
            if (operation === 'D') socket.write('D');
            else socket.end(Buffer.concat([Buffer.from('U'), Buffer.alloc(payloadBytes, 9)]));
        });
        socket.on('data', (chunk) => {
            if (operation === 'D') downloaded += chunk.length;
        });
        socket.once('error', reject);
        socket.once('end', () => {
            if (operation === 'D' && downloaded !== payloadBytes) {
                reject(new Error(`Expected ${payloadBytes} bytes, received ${downloaded}`));
                return;
            }
            resolve((performance.now() - startedAt) / 1_000);
        });
    });

const writeLimiter = (route, rate = route.rate) =>
    writeFile(path.join(temporaryDirectory, route.id), `$ ${rate}B ${rate}B\n`, 'utf8');

try {
    await listen(upstream, upstreamPort);
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
            handler: { type: 'tcp' },
            listener: { type: 'tcp' },
            forwarder: {
                nodes: [{ name: 'upstream', addr: `127.0.0.1:${upstreamPort}` }],
            },
        })),
    };
    const configPath = path.join(temporaryDirectory, 'config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    gostProcess = spawn(gostBinary, ['-C', configPath], { stdio: 'ignore' });
    await Promise.all(routes.map((route) => waitForPort(route.port)));

    // Consume Route B's initial burst immediately before measuring its baseline.
    await transfer(routes[1].port, 'D');
    const routeBAlone = await transfer(routes[1].port, 'D');
    const [routeADownload, routeBDownload] = await Promise.all(
        routes.map((route) => transfer(route.port, 'D')),
    );
    // Consume the independent input-direction bursts in an order that avoids refill skew.
    await transfer(routes[0].port, 'U');
    await transfer(routes[1].port, 'U');
    const [routeAUpload, routeBUpload] = await Promise.all(
        routes.map((route) => transfer(route.port, 'U')),
    );

    await writeLimiter(routes[0], 500_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const routeAAfterUpdate = await transfer(routes[0].port, 'D');

    if (routeADownload < routeBDownload * 2) {
        throw new Error('Per-route download buckets were not independent enough');
    }
    if (routeAUpload < routeBUpload * 2) {
        throw new Error('Per-route upload buckets were not independent enough');
    }
    if (routeBDownload > routeBAlone * 1.8 + 0.5) {
        throw new Error('Route B slowed down as if it shared Route A bucket');
    }
    if (routeAAfterUpdate >= routeADownload * 0.8) {
        throw new Error('Dynamic limiter source update did not increase Route A throughput');
    }

    // oxlint-disable-next-line no-console -- this script emits machine-readable E2E metrics.
    console.log(
        JSON.stringify(
            {
                payloadBytes,
                routeBAloneSeconds: routeBAlone,
                concurrentDownloadSeconds: { routeA: routeADownload, routeB: routeBDownload },
                concurrentUploadSeconds: { routeA: routeAUpload, routeB: routeBUpload },
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
