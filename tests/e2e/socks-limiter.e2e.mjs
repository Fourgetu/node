/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const image = process.env.DUAL_CORE_IMAGE || 'remnawave-node-dualcore:amd64-hopping-test';
const suffix = process.pid;
const names = {
    network: `remnawave-socks-limit-${suffix}`,
    runtime: `remnawave-socks-limit-runtime-${suffix}`,
    target: `remnawave-socks-limit-target-${suffix}`,
};
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'remnawave-socks-limit-'));

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

const encodeAuth = (username, password) => {
    const user = Buffer.from(username);
    const pass = Buffer.from(password);
    return Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]);
};

const measure = async (port, username, password) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.setTimeout(20_000, () => socket.destroy(new Error('SOCKS download timed out')));
    const reader = new Reader(socket);
    socket.write(Buffer.from([5, 1, 2]));
    if (!(await reader.read(2)).equals(Buffer.from([5, 2]))) {
        throw new Error(`SOCKS ${port} did not require username/password`);
    }
    socket.write(encodeAuth(username, password));
    if (!(await reader.read(2)).equals(Buffer.from([1, 0]))) {
        throw new Error(`SOCKS ${port} rejected the assigned credential`);
    }
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
    socket.write('GET /stream HTTP/1.1\r\nHost: http-target\r\n\r\n');
    let header = Buffer.alloc(0);
    while (!header.includes('\r\n\r\n')) header = Buffer.concat([header, await reader.read(1)]);

    reader.stop();
    let bytes = 0;
    socket.on('data', (chunk) => {
        bytes += chunk.length;
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    bytes = 0;
    const started = performance.now();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 8_000));
    const seconds = (performance.now() - started) / 1_000;
    socket.destroy();
    return { bytes, mbps: (bytes * 8) / seconds / 1_000_000 };
};

const users = [
    { username: 'user-a', password: 'password-a' },
    { username: 'user-b', password: 'password-b' },
];
const xray = {
    log: { loglevel: 'warning' },
    inbounds: [
        {
            tag: 'xray-socks',
            listen: '127.0.0.1',
            port: 1080,
            protocol: 'socks',
            settings: {
                auth: 'password',
                accounts: users.map((item) => ({ user: item.username, pass: item.password })),
                udp: true,
            },
        },
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
};
const singbox = {
    log: { level: 'warn' },
    inbounds: [
        {
            type: 'socks',
            tag: 'singbox-socks',
            listen: '127.0.0.1',
            listen_port: 1081,
            users,
        },
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
};
const limiter = (name, bytesPerSecond) => ({ name, limits: [`$ 0B ${bytesPerSecond}B`] });
const service = (name, port, limiterName, targetPort) => ({
    name,
    addr: `0.0.0.0:${port}`,
    limiter: limiterName,
    handler: { type: 'tcp' },
    listener: { type: 'tcp' },
    forwarder: { nodes: [{ name: 'core', addr: `127.0.0.1:${targetPort}` }] },
});
const gost = {
    limiters: [
        limiter('xray-a', 2_500_000),
        limiter('xray-b', 12_500_000),
        limiter('singbox-a', 2_500_000),
        limiter('singbox-b', 12_500_000),
    ],
    services: [
        service('xray-a', 32_201, 'xray-a', 1080),
        service('xray-b', 32_202, 'xray-b', 1080),
        service('singbox-a', 32_203, 'singbox-a', 1081),
        service('singbox-b', 32_204, 'singbox-b', 1081),
    ],
};

const assertPair = (core, userA, userB) => {
    if (userA.mbps < 16 || userA.mbps > 30) throw new Error(`${core} User A: ${userA.mbps}`);
    if (userB.mbps < 75 || userB.mbps > 135) throw new Error(`${core} User B: ${userB.mbps}`);
    if (userB.mbps <= userA.mbps * 3) throw new Error(`${core} buckets were not independent`);
};

try {
    await Promise.all([
        writeFile(join(temporaryDirectory, 'xray.json'), JSON.stringify(xray, null, 2)),
        writeFile(join(temporaryDirectory, 'singbox.json'), JSON.stringify(singbox, null, 2)),
        writeFile(join(temporaryDirectory, 'gost.json'), JSON.stringify(gost, null, 2)),
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
        '--name',
        names.runtime,
        '--entrypoint',
        '/bin/sh',
        ...[32_201, 32_202, 32_203, 32_204].flatMap((port) => ['-p', `127.0.0.1:${port}:${port}`]),
        '-v',
        `${temporaryDirectory}:/test:ro`,
        image,
        '-c',
        '/usr/local/bin/xray run -config /test/xray.json >/tmp/xray.log 2>&1 & ' +
            '/usr/local/bin/sing-box run -c /test/singbox.json >/tmp/singbox.log 2>&1 & ' +
            'exec /usr/local/bin/gost -C /test/gost.json >/tmp/gost.log 2>&1',
    ]);
    await Promise.all([32_201, 32_202, 32_203, 32_204].map(waitForPort));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));

    const [xrayA, xrayB] = await Promise.all([
        measure(32_201, users[0].username, users[0].password),
        measure(32_202, users[1].username, users[1].password),
    ]);
    assertPair('Xray SOCKS', xrayA, xrayB);
    const [singboxA, singboxB] = await Promise.all([
        measure(32_203, users[0].username, users[0].password),
        measure(32_204, users[1].username, users[1].password),
    ]);
    assertPair('sing-box SOCKS', singboxA, singboxB);

    console.log(
        JSON.stringify(
            {
                xray: { userA: xrayA, userB: xrayB },
                singbox: { userA: singboxA, userB: singboxB },
            },
            null,
            2,
        ),
    );
    console.log('PASS: Xray SOCKS users retained independent 20/100 Mbps GOST buckets.');
    console.log('PASS: sing-box SOCKS users retained independent 20/100 Mbps GOST buckets.');
} catch (error) {
    for (const name of [names.runtime, names.target]) {
        const logs = cleanupDocker(['logs', name]);
        if (logs.stdout || logs.stderr) console.error(`--- ${name}\n${logs.stdout}${logs.stderr}`);
    }
    throw error;
} finally {
    cleanupDocker(['rm', '-f', names.runtime, names.target]);
    cleanupDocker(['network', 'rm', names.network]);
    await rm(temporaryDirectory, { recursive: true, force: true });
}
