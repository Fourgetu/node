/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.env.DUAL_CORE_IMAGE || 'remnawave-node-dualcore:amd64-hopping-test';
const suffix = process.pid;
const names = {
    network: `remnawave-anytls-limit-${suffix}`,
    server: `remnawave-anytls-limit-server-${suffix}`,
    clientA: `remnawave-anytls-limit-a-${suffix}`,
    clientB: `remnawave-anytls-limit-b-${suffix}`,
    target: `remnawave-anytls-limit-target-${suffix}`,
};
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'remnawave-anytls-limit-'));
const testDirectory = dirname(fileURLToPath(import.meta.url));
const socksFixtureDirectory = resolve(testDirectory, '../runtime-fixtures/dual-core-socks');

const docker = (args, capture = false) => {
    const result = spawnSync('docker', args, {
        encoding: 'utf8',
        stdio: capture ? 'pipe' : 'inherit',
        timeout: 60_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `docker ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`,
        );
    }
    return result;
};

const cleanupDocker = (args) =>
    spawnSync('docker', args, { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });

const waitForPort = async (port) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const socket = createConnection({ host: '127.0.0.1', port });
        const ready = await Promise.race([
            once(socket, 'connect').then(() => true),
            once(socket, 'error').then(() => false),
            new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 250)),
        ]);
        socket.destroy();
        if (ready) return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    throw new Error(`Timed out waiting for ${port}`);
};

class Reader {
    buffer = Buffer.alloc(0);
    pending = [];

    constructor(socket) {
        this.socket = socket;
        this.onData = (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            while (this.pending.length > 0 && this.buffer.length >= this.pending[0].length) {
                const request = this.pending.shift();
                request.resolve(this.take(request.length));
            }
        };
        socket.on('data', this.onData);
        socket.on('error', (error) => {
            for (const request of this.pending.splice(0)) request.reject(error);
        });
    }

    read(length) {
        if (this.buffer.length >= length) return Promise.resolve(this.take(length));
        return new Promise((resolveRead, rejectRead) =>
            this.pending.push({ length, resolve: resolveRead, reject: rejectRead }),
        );
    }

    take(length) {
        const value = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        return value;
    }

    stop() {
        this.socket.off('data', this.onData);
        this.buffer = Buffer.alloc(0);
    }
}

const measure = async (port) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.setTimeout(20_000, () => socket.destroy(new Error('AnyTLS download timed out')));
    const reader = new Reader(socket);
    socket.write(Buffer.from([5, 1, 0]));
    if (!(await reader.read(2)).equals(Buffer.from([5, 0])))
        throw new Error('SOCKS greeting failed');

    const host = Buffer.from('http-target');
    socket.write(
        Buffer.concat([
            Buffer.from([5, 1, 0, 3, host.length]),
            host,
            Buffer.from([18080 >> 8, 18080 & 0xff]),
        ]),
    );
    const reply = await reader.read(4);
    if (reply[1] !== 0) throw new Error(`SOCKS CONNECT failed: ${reply[1]}`);
    const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await reader.read(1))[0];
    await reader.read(addressLength + 2);
    socket.write('GET / HTTP/1.1\r\nHost: http-target\r\n\r\n');
    let header = Buffer.alloc(0);
    while (!header.includes('\r\n\r\n')) header = Buffer.concat([header, await reader.read(1)]);

    reader.stop();
    let bytes = 0;
    const count = (chunk) => {
        bytes += chunk.length;
    };
    socket.on('data', count);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    bytes = 0;
    const started = performance.now();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 8_000));
    const seconds = (performance.now() - started) / 1_000;
    socket.destroy();
    return { bytes, mbps: (bytes * 8) / seconds / 1_000_000 };
};

const server = {
    log: { level: 'warn' },
    inbounds: [
        {
            type: 'anytls',
            tag: 'anytls',
            listen: '127.0.0.1',
            listen_port: 10_003,
            users: [
                { name: 'A', password: 'anytls-password-a' },
                { name: 'B', password: 'anytls-password-b' },
            ],
            tls: {
                enabled: true,
                alpn: ['h2', 'http/1.1'],
                certificate_path: '/tmp/anytls-cert.pem',
                key_path: '/tmp/anytls-key.pem',
            },
        },
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
};
const gost = {
    limiters: [
        { name: 'user-a', limits: ['$ 0B 2500000B'] },
        { name: 'user-b', limits: ['$ 0B 12500000B'] },
    ],
    services: [
        {
            name: 'user-a-tcp',
            addr: '0.0.0.0:32101',
            limiter: 'user-a',
            handler: { type: 'tcp' },
            listener: { type: 'tcp' },
            forwarder: { nodes: [{ name: 'singbox', addr: '127.0.0.1:10003' }] },
        },
        {
            name: 'user-b-tcp',
            addr: '0.0.0.0:32102',
            limiter: 'user-b',
            handler: { type: 'tcp' },
            listener: { type: 'tcp' },
            forwarder: { nodes: [{ name: 'singbox', addr: '127.0.0.1:10003' }] },
        },
    ],
};
const client = (id, serverPort, listenPort) => ({
    log: { level: 'warn' },
    inbounds: [{ type: 'socks', listen: '0.0.0.0', listen_port: listenPort }],
    outbounds: [
        {
            type: 'anytls',
            tag: 'anytls-out',
            server: 'anytls-server',
            server_port: serverPort,
            password: `anytls-password-${id.toLowerCase()}`,
            tls: { enabled: true, server_name: 'localhost', insecure: true },
        },
    ],
    route: { final: 'anytls-out' },
});

const assertProcesses = () => {
    const output = docker(
        [
            'exec',
            names.server,
            'sh',
            '-c',
            'for p in /proc/[0-9]*/comm; do cat "$p" 2>/dev/null; done',
        ],
        true,
    ).stdout.split(/\r?\n/);
    for (const processName of ['xray', 'sing-box', 'gost']) {
        if (!output.includes(processName))
            throw new Error(`${processName} stopped during AnyTLS E2E`);
    }
};

try {
    await Promise.all([
        writeFile(join(temporaryDirectory, 'server.json'), JSON.stringify(server, null, 2)),
        writeFile(join(temporaryDirectory, 'gost.json'), JSON.stringify(gost, null, 2)),
        writeFile(
            join(temporaryDirectory, 'client-a.json'),
            JSON.stringify(client('A', 32_101, 12_090), null, 2),
        ),
        writeFile(
            join(temporaryDirectory, 'client-b.json'),
            JSON.stringify(client('B', 32_102, 12_091), null, 2),
        ),
    ]);
    docker(['image', 'inspect', image], true);
    docker(['network', 'create', names.network]);
    docker([
        'run',
        '--rm',
        '-d',
        '--network',
        names.network,
        '--network-alias',
        'http-target',
        '--name',
        names.target,
        '--entrypoint',
        'node',
        image,
        '-e',
        "require('node:http').createServer((q,s)=>{s.writeHead(200);const b=Buffer.alloc(65536,7);const w=()=>{while(s.write(b)){};s.once('drain',w)};w()}).listen(18080,'0.0.0.0')",
    ]);
    docker([
        'run',
        '--rm',
        '-d',
        '--network',
        names.network,
        '--network-alias',
        'anytls-server',
        '--name',
        names.server,
        '--entrypoint',
        '/bin/sh',
        '-v',
        `${temporaryDirectory}:/test:ro`,
        '-v',
        `${socksFixtureDirectory}:/socks:ro`,
        image,
        '-c',
        "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' " +
            '-keyout /tmp/anytls-key.pem -out /tmp/anytls-cert.pem >/dev/null 2>&1 || exit 1; ' +
            '/usr/local/bin/xray run -config /socks/xray.json >/tmp/xray.log 2>&1 & ' +
            '/usr/local/bin/sing-box run -c /test/server.json >/tmp/singbox.log 2>&1 & ' +
            'exec /usr/local/bin/gost -C /test/gost.json >/tmp/gost.log 2>&1',
    ]);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    assertProcesses();

    for (const [name, config, port] of [
        [names.clientA, 'client-a.json', 12_090],
        [names.clientB, 'client-b.json', 12_091],
    ]) {
        docker([
            'run',
            '--rm',
            '-d',
            '--network',
            names.network,
            '--name',
            name,
            '--entrypoint',
            '/usr/local/bin/sing-box',
            '-p',
            `127.0.0.1:${port}:${port}`,
            '-v',
            `${temporaryDirectory}:/test:ro`,
            image,
            'run',
            '-c',
            `/test/${config}`,
        ]);
    }
    await Promise.all([waitForPort(12_090), waitForPort(12_091)]);
    const [userA, userB] = await Promise.all([measure(12_090), measure(12_091)]);
    assertProcesses();

    if (userA.mbps < 16 || userA.mbps > 30) throw new Error(`User A: ${userA.mbps} Mbps`);
    if (userB.mbps < 75 || userB.mbps > 135) throw new Error(`User B: ${userB.mbps} Mbps`);
    if (userB.mbps <= userA.mbps * 3)
        throw new Error('AnyTLS limiter buckets were not independent');

    console.log(JSON.stringify({ userA, userB }, null, 2));
    console.log('PASS: two real AnyTLS clients retained independent 20/100 Mbps GOST buckets.');
    console.log('PASS: Xray, sing-box, and GOST remained running.');
} catch (error) {
    for (const name of [names.server, names.clientA, names.clientB, names.target]) {
        const logs = cleanupDocker(['logs', name]);
        if (logs.stdout || logs.stderr) console.error(`--- ${name}\n${logs.stdout}${logs.stderr}`);
    }
    throw error;
} finally {
    for (const name of [names.clientA, names.clientB, names.server, names.target]) {
        cleanupDocker(['rm', '-f', name]);
    }
    cleanupDocker(['network', 'rm', names.network]);
    await rm(temporaryDirectory, { recursive: true, force: true });
}
