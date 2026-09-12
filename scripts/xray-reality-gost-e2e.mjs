import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const gostBinary = process.env.GOST_BINARY_PATH ?? '/usr/local/bin/gost';
const xrayBinary = process.env.XRAY_BINARY_PATH ?? '/usr/local/bin/xray';
const downloadPayloadBytes = 25_000_000;
const uploadPayloadBytes = 100_000_000;
const upstreamPort = 39_820;
const internalXrayPort = 39_821;
const routes = [
    {
        id: 'reality-route-a',
        externalPort: 39_822,
        socksPort: 39_824,
        uuid: '11111111-1111-4111-8111-111111111111',
        downloadRate: 2_500_000,
        uploadRate: 2_500_000,
    },
    {
        id: 'reality-route-b',
        externalPort: 39_823,
        socksPort: 39_825,
        uuid: '22222222-2222-4222-8222-222222222222',
        downloadRate: 12_500_000,
        uploadRate: 6_250_000,
    },
];
const shortId = '0123456789abcdef';
const serverName = 'www.cloudflare.com';
const debug = Boolean(process.env.XRAY_E2E_DEBUG);
const trace = (message) => {
    if (debug) process.stderr.write(`[reality-e2e] ${message}\n`);
};

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'xray-reality-gost-e2e-'));
const processes = [];

const upstream = net.createServer((socket) => {
    let operation;
    let uploaded = 0;

    socket.on('data', (chunk) => {
        if (!operation) {
            operation = String.fromCharCode(chunk[0]);
            chunk = chunk.subarray(1);
            if (operation === 'P') {
                operation = undefined;
                socket.write('R');
                return;
            }
            if (operation === 'D') {
                socket.end(Buffer.alloc(downloadPayloadBytes, 7));
                return;
            }
        }

        if (operation === 'U') {
            uploaded += chunk.length;
            if (uploaded >= uploadPayloadBytes) socket.end('OK');
        }
    });
});

const listen = (server, port) =>
    new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });

const waitForPort = async (port) => {
    const deadline = Date.now() + 15_000;
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

const readOnce = (socket) =>
    new Promise((resolve, reject) => {
        socket.once('data', resolve);
        socket.once('error', reject);
    });

const connectThroughSocks = async (socksPort) => {
    const socket = net.connect(socksPort, '127.0.0.1');
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });

    socket.write(Buffer.from([5, 1, 0]));
    const greeting = await readOnce(socket);
    if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error('SOCKS authentication failed');

    socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, upstreamPort >> 8, upstreamPort & 0xff]));
    const response = await readOnce(socket);
    if (response[0] !== 5 || response[1] !== 0) {
        throw new Error(`SOCKS connect failed with status ${response[1]}`);
    }
    return socket;
};

const transfer = async (route, operation) => {
    const socket = await connectThroughSocks(route.socksPort);
    socket.write('P');
    const ready = await readOnce(socket);
    if (ready.toString() !== 'R') throw new Error('Tunnel preflight failed');
    const startedAt = performance.now();
    let downloaded = 0;

    return new Promise((resolve, reject) => {
        if (operation === 'D') socket.write('D');
        else socket.end(Buffer.concat([Buffer.from('U'), Buffer.alloc(uploadPayloadBytes, 9)]));

        socket.on('data', (chunk) => {
            if (operation === 'D') downloaded += chunk.length;
        });
        socket.once('error', reject);
        socket.once('end', () => {
            if (operation === 'D' && downloaded !== downloadPayloadBytes) {
                reject(new Error(`Expected ${downloadPayloadBytes} bytes, received ${downloaded}`));
                return;
            }
            resolve((performance.now() - startedAt) / 1_000);
        });
    });
};

const keyOutput = spawnSync(xrayBinary, ['x25519'], { encoding: 'utf8' });
if (keyOutput.status !== 0) throw new Error(`xray x25519 failed: ${keyOutput.stderr}`);
const privateKey = /PrivateKey:\s+(\S+)/.exec(keyOutput.stdout)?.[1];
const publicKey = /Password \(PublicKey\):\s+(\S+)/.exec(keyOutput.stdout)?.[1];
if (!privateKey || !publicKey) throw new Error('Unable to parse Xray Reality keypair');

const serverConfig = {
    log: { loglevel: debug ? 'info' : 'warning' },
    inbounds: [
        {
            tag: 'shared-reality-inbound',
            listen: '127.0.0.1',
            port: internalXrayPort,
            protocol: 'vless',
            settings: {
                clients: routes.map((route) => ({ id: route.uuid, flow: 'xtls-rprx-vision' })),
                decryption: 'none',
            },
            streamSettings: {
                network: 'raw',
                security: 'reality',
                realitySettings: {
                    show: false,
                    target: `${serverName}:443`,
                    xver: 0,
                    serverNames: [serverName],
                    privateKey,
                    shortIds: [shortId],
                },
            },
        },
    ],
    outbounds: [
        {
            protocol: 'freedom',
            tag: 'direct',
            settings: {
                finalRules: [
                    {
                        action: 'allow',
                        network: 'tcp',
                        port: String(upstreamPort),
                        ip: ['127.0.0.1'],
                    },
                ],
            },
        },
    ],
};

const clientConfig = {
    log: { loglevel: debug ? 'info' : 'warning' },
    inbounds: routes.map((route) => ({
        tag: `socks-${route.id}`,
        listen: '127.0.0.1',
        port: route.socksPort,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: false },
    })),
    outbounds: routes.map((route) => ({
        tag: route.id,
        protocol: 'vless',
        settings: {
            vnext: [
                {
                    address: '127.0.0.1',
                    port: route.externalPort,
                    users: [{ id: route.uuid, encryption: 'none', flow: 'xtls-rprx-vision' }],
                },
            ],
        },
        streamSettings: {
            network: 'raw',
            security: 'reality',
            realitySettings: {
                serverName,
                fingerprint: 'chrome',
                publicKey,
                shortId,
            },
        },
    })),
    routing: {
        rules: routes.map((route) => ({
            type: 'field',
            inboundTag: [`socks-${route.id}`],
            outboundTag: route.id,
        })),
    },
};

const writeLimiter = (route, uploadRate = route.uploadRate, downloadRate = route.downloadRate) =>
    writeFile(
        path.join(temporaryDirectory, route.id),
        `$ ${uploadRate}B ${downloadRate}B\n`,
        'utf8',
    );

try {
    await listen(upstream, upstreamPort);
    await Promise.all(routes.map((route) => writeLimiter(route)));

    const serverConfigPath = path.join(temporaryDirectory, 'server.json');
    const clientConfigPath = path.join(temporaryDirectory, 'client.json');
    const gostConfigPath = path.join(temporaryDirectory, 'gost.json');
    const serverConfigText = JSON.stringify(serverConfig, null, 2);
    const clientConfigText = JSON.stringify(clientConfig, null, 2);
    await writeFile(serverConfigPath, serverConfigText, 'utf8');
    await writeFile(clientConfigPath, clientConfigText, 'utf8');
    await writeFile(
        gostConfigPath,
        JSON.stringify(
            {
                limiters: routes.map((route) => ({
                    name: route.id,
                    reload: '1s',
                    file: { path: path.join(temporaryDirectory, route.id) },
                })),
                services: routes.map((route) => ({
                    name: route.id,
                    addr: `127.0.0.1:${route.externalPort}`,
                    limiter: route.id,
                    handler: { type: 'tcp' },
                    listener: { type: 'tcp' },
                    forwarder: {
                        nodes: [
                            {
                                name: 'shared-xray-inbound',
                                addr: `127.0.0.1:${internalXrayPort}`,
                            },
                        ],
                    },
                })),
            },
            null,
            2,
        ),
        'utf8',
    );

    processes.push(
        spawn(xrayBinary, ['run', '-c', serverConfigPath], {
            stdio: debug ? 'inherit' : 'ignore',
        }),
    );
    await waitForPort(internalXrayPort);
    trace('Xray server is ready');
    processes.push(
        spawn(gostBinary, ['-C', gostConfigPath], { stdio: debug ? 'inherit' : 'ignore' }),
    );
    await Promise.all(routes.map((route) => waitForPort(route.externalPort)));
    trace('GOST routes are ready');
    processes.push(
        spawn(xrayBinary, ['run', '-c', clientConfigPath], {
            stdio: debug ? 'inherit' : 'ignore',
        }),
    );
    await Promise.all(routes.map((route) => waitForPort(route.socksPort)));
    trace('Xray clients are ready');

    await transfer(routes[1], 'D');
    trace('Route B download bucket warmed');
    const routeBAlone = await transfer(routes[1], 'D');
    trace('Route B baseline complete');
    const [routeADownload, routeBDownload] = await Promise.all(
        routes.map((route) => transfer(route, 'D')),
    );
    trace('Concurrent download complete');
    const [routeAUpload, routeBUpload] = await Promise.all(
        routes.map((route) => transfer(route, 'U')),
    );
    trace('Concurrent upload complete');

    await writeLimiter(routes[0], 6_250_000, 6_250_000);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await transfer(routes[0], 'D');
    const routeAAfterUpdate = await transfer(routes[0], 'D');

    const measured = {
        routeBAlone,
        routeADownload,
        routeBDownload,
        routeAUpload,
        routeBUpload,
        routeAAfterUpdate,
    };
    if (process.env.XRAY_E2E_METRICS) {
        process.stderr.write(`${JSON.stringify(measured)}\n`);
    }

    if (routeADownload < routeBDownload * 2 || routeAUpload < routeBUpload * 2) {
        throw new Error('Reality users did not retain independent GOST buckets');
    }
    if (routeBDownload > routeBAlone * 1.8 + 0.5) {
        throw new Error('Reality Route B slowed down as if it shared Route A bucket');
    }
    if (routeAAfterUpdate >= routeADownload * 0.8) {
        throw new Error('Reality Route A did not apply the dynamic limiter update');
    }
    if (
        (await readFile(serverConfigPath, 'utf8')) !== serverConfigText ||
        (await readFile(clientConfigPath, 'utf8')) !== clientConfigText
    ) {
        throw new Error('Xray configuration changed during limiter-only update');
    }

    // oxlint-disable-next-line no-console -- this script emits machine-readable E2E metrics.
    console.log(
        JSON.stringify(
            {
                protocol: 'VLESS Reality Vision',
                sharedInbound: `127.0.0.1:${internalXrayPort}`,
                userUuids: routes.map((route) => route.uuid),
                configuredMbps: {
                    routeA: { download: 20, upload: 20 },
                    routeB: { download: 100, upload: 50 },
                    routeAAfterUpdate: { download: 50, upload: 50 },
                },
                payloadBytes: {
                    download: downloadPayloadBytes,
                    upload: uploadPayloadBytes,
                },
                routeBAloneSeconds: routeBAlone,
                concurrentDownloadSeconds: { routeA: routeADownload, routeB: routeBDownload },
                concurrentUploadSeconds: { routeA: routeAUpload, routeB: routeBUpload },
                routeAAfterDynamicUpdateSeconds: routeAAfterUpdate,
                xrayConfigUnchanged: true,
            },
            null,
            2,
        ),
    );
} finally {
    for (const process of processes.reverse()) process.kill('SIGTERM');
    upstream.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
}
