/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.env.PORT_HOPPING_IMAGE || 'remnawave-node-dualcore:amd64-hopping-test';
const suffix = process.pid;
const names = {
    network: `remnawave-hy2-hop-${suffix}`,
    server: `remnawave-hy2-hop-server-${suffix}`,
    clientA: `remnawave-hy2-hop-client-a-${suffix}`,
    clientB: `remnawave-hy2-hop-client-b-${suffix}`,
    target: `remnawave-hy2-hop-target-${suffix}`,
};
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'remnawave-hy2-hop-'));
const testDirectory = dirname(fileURLToPath(import.meta.url));
const socksFixtureDirectory = resolve(testDirectory, '../runtime-fixtures/dual-core-socks');

const docker = (args, options = {}) => {
    const result = spawnSync('docker', args, {
        encoding: 'utf8',
        stdio: options.capture ? 'pipe' : 'inherit',
        timeout: options.timeout ?? 60_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
        throw new Error(
            `docker ${args.join(' ')} failed with exit code ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
        );
    }
    return result;
};

const waitForPort = async (port) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const socket = createConnection({ host: '127.0.0.1', port });
        const outcome = await Promise.race([
            once(socket, 'connect').then(() => true),
            once(socket, 'error').then(() => false),
            new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 250)),
        ]);
        socket.destroy();
        if (outcome) return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    throw new Error(`Timed out waiting for TCP port ${port}`);
};

class SocketReader {
    buffer = Buffer.alloc(0);
    pending = [];

    constructor(socket) {
        this.socket = socket;
        this.onData = (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.flush();
        };
        socket.on('data', this.onData);
        socket.on('error', (error) => this.fail(error));
        socket.on('end', () => this.fail(new Error('SOCKS connection ended unexpectedly')));
    }

    read(length) {
        if (this.buffer.length >= length) return Promise.resolve(this.take(length));
        return new Promise((resolveRead, rejectRead) => {
            this.pending.push({ length, resolveRead, rejectRead });
        });
    }

    flush() {
        while (this.pending.length > 0 && this.buffer.length >= this.pending[0].length) {
            const request = this.pending.shift();
            request.resolveRead(this.take(request.length));
        }
    }

    fail(error) {
        for (const request of this.pending.splice(0)) request.rejectRead(error);
    }

    take(length) {
        const value = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        return value;
    }

    stop() {
        this.socket.off('data', this.onData);
        const buffered = this.buffer;
        this.buffer = Buffer.alloc(0);
        return buffered;
    }
}

const measureDownload = async (port, durationMs = 12_000) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.setTimeout(20_000, () => socket.destroy(new Error('Hysteria2 download timed out')));
    const reader = new SocketReader(socket);

    socket.write(Buffer.from([5, 1, 0]));
    const greeting = await reader.read(2);
    if (!greeting.equals(Buffer.from([5, 0]))) throw new Error('Client SOCKS greeting failed');

    const host = Buffer.from('http-target');
    socket.write(
        Buffer.concat([
            Buffer.from([5, 1, 0, 3, host.length]),
            host,
            Buffer.from([18080 >> 8, 18080 & 0xff]),
        ]),
    );
    const reply = await reader.read(4);
    if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS CONNECT failed: ${reply[1]}`);
    const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await reader.read(1))[0];
    await reader.read(addressLength + 2);

    socket.write('GET /stream HTTP/1.1\r\nHost: http-target\r\nConnection: close\r\n\r\n');
    let headerBuffer = Buffer.alloc(0);
    while (!headerBuffer.includes('\r\n\r\n')) {
        headerBuffer = Buffer.concat([headerBuffer, await reader.read(1)]);
    }

    let bytes = 0;
    const onData = (chunk) => {
        bytes += chunk.length;
    };
    bytes += reader.stop().length;
    socket.on('data', onData);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    bytes = 0;
    const startedAt = performance.now();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
    socket.off('data', onData);
    const seconds = (performance.now() - startedAt) / 1_000;
    socket.destroy();
    return { bytes, mbps: (bytes * 8) / seconds / 1_000_000 };
};

const serverConfig = {
    log: { level: 'warn', timestamp: true },
    inbounds: [
        {
            type: 'hysteria2',
            tag: 'hy2',
            listen: '127.0.0.1',
            listen_port: 10002,
            users: [
                { name: 'A', password: 'hy2-password-a' },
                { name: 'B', password: 'hy2-password-b' },
            ],
            obfs: { type: 'salamander', password: 'hy2-obfs-password' },
            tls: {
                enabled: true,
                alpn: ['h3'],
                certificate_path: '/tmp/hy2-cert.pem',
                key_path: '/tmp/hy2-key.pem',
            },
        },
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
};

const gostConfig = {
    limiters: [
        { name: 'user-a', limits: ['$ 0B 2500000B'] },
        { name: 'user-b', limits: ['$ 0B 12500000B'] },
    ],
    services: [
        {
            name: 'user-a-udp',
            addr: '0.0.0.0:32001',
            limiter: 'user-a',
            handler: { type: 'udp' },
            listener: { type: 'udp', metadata: { keepAlive: true } },
            forwarder: { nodes: [{ name: 'singbox', addr: '127.0.0.1:10002' }] },
        },
        {
            name: 'user-b-udp',
            addr: '0.0.0.0:32002',
            limiter: 'user-b',
            handler: { type: 'udp' },
            listener: { type: 'udp', metadata: { keepAlive: true } },
            forwarder: { nodes: [{ name: 'singbox', addr: '127.0.0.1:10002' }] },
        },
    ],
};

const clientConfig = (id, start, end, listenPort) => ({
    log: { level: 'warn', timestamp: true },
    inbounds: [{ type: 'socks', tag: 'client-socks', listen: '0.0.0.0', listen_port: listenPort }],
    outbounds: [
        {
            type: 'hysteria2',
            tag: 'hy2-out',
            server: 'hy2-server',
            server_ports: [`${start}:${end}`],
            hop_interval: '2s',
            up_mbps: 200,
            down_mbps: 200,
            password: `hy2-password-${id.toLowerCase()}`,
            obfs: { type: 'salamander', password: 'hy2-obfs-password' },
            tls: { enabled: true, server_name: 'localhost', insecure: true },
        },
    ],
    route: { final: 'hy2-out' },
});

const nftRules = () => {
    const lines = [
        'flush table inet remnawave_hopping',
        'add chain inet remnawave_hopping prerouting { type nat hook prerouting priority dstnat; policy accept; }',
    ];
    for (let port = 20_000; port <= 20_019; port += 1) {
        lines.push(
            `add rule inet remnawave_hopping prerouting udp dport ${port} counter redirect to :32001 comment "user-a-${port}"`,
        );
    }
    for (let port = 20_020; port <= 20_039; port += 1) {
        lines.push(
            `add rule inet remnawave_hopping prerouting udp dport ${port} counter redirect to :32002 comment "user-b-${port}"`,
        );
    }
    return `${lines.join('\n')}\n`;
};

const assertProcesses = () => {
    const result = docker(
        [
            'exec',
            names.server,
            'sh',
            '-c',
            'for p in /proc/[0-9]*/comm; do cat "$p" 2>/dev/null; done',
        ],
        { capture: true },
    );
    for (const processName of ['xray', 'sing-box', 'gost']) {
        if (!result.stdout.split(/\r?\n/).includes(processName)) {
            throw new Error(`${processName} is not running during Hysteria2 hopping`);
        }
    }
};

const usedHopPorts = (rulesOutput, prefix) =>
    rulesOutput
        .split(/\r?\n/)
        .filter(
            (line) => line.includes(`comment "${prefix}-`) && /counter packets [1-9]\d*/.test(line),
        )
        .map((line) => Number(line.match(/udp dport (\d+)/)?.[1]))
        .filter(Number.isInteger);

const assertIndependentLimits = (userA, userB, phase) => {
    if (userA.mbps < 15 || userA.mbps > 30) {
        throw new Error(`User A real HY2 rate outside 20 Mbps tolerance ${phase}: ${userA.mbps}`);
    }
    if (userB.mbps < 55 || userB.mbps > 145) {
        throw new Error(`User B real HY2 rate outside 100 Mbps tolerance ${phase}: ${userB.mbps}`);
    }
    if (userB.mbps <= userA.mbps * 2.5) {
        throw new Error(
            `Real HY2 limiter buckets were not independent ${phase}: A=${userA.mbps}, B=${userB.mbps}`,
        );
    }
};

const readUsedHopPorts = () => {
    const nft = docker(
        [
            'exec',
            names.server,
            'nft',
            '-nn',
            'list',
            'chain',
            'inet',
            'remnawave_hopping',
            'prerouting',
        ],
        { capture: true },
    ).stdout;
    return {
        nft,
        userA: usedHopPorts(nft, 'user-a'),
        userB: usedHopPorts(nft, 'user-b'),
    };
};

try {
    await Promise.all([
        writeFile(join(temporaryDirectory, 'server.json'), JSON.stringify(serverConfig, null, 2)),
        writeFile(join(temporaryDirectory, 'gost.json'), JSON.stringify(gostConfig, null, 2)),
        writeFile(
            join(temporaryDirectory, 'client-a.json'),
            JSON.stringify(clientConfig('A', 20_000, 20_019, 12_080), null, 2),
        ),
        writeFile(
            join(temporaryDirectory, 'client-b.json'),
            JSON.stringify(clientConfig('B', 20_020, 20_039, 12_081), null, 2),
        ),
        writeFile(join(temporaryDirectory, 'rules.nft'), nftRules()),
    ]);

    docker(['image', 'inspect', image], { capture: true });
    docker([
        'run',
        '--rm',
        '--entrypoint',
        '/bin/sh',
        '-v',
        `${temporaryDirectory}:/test:ro`,
        image,
        '-c',
        "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' " +
            '-keyout /tmp/hy2-key.pem -out /tmp/hy2-cert.pem >/dev/null 2>&1 && ' +
            '/usr/local/bin/sing-box check -c /test/server.json',
    ]);
    for (const config of ['client-a.json', 'client-b.json']) {
        docker([
            'run',
            '--rm',
            '--entrypoint',
            '/usr/local/bin/sing-box',
            '-v',
            `${temporaryDirectory}:/test:ro`,
            image,
            'check',
            '-c',
            `/test/${config}`,
        ]);
    }

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
        '--cap-add',
        'NET_ADMIN',
        '--network',
        names.network,
        '--network-alias',
        'hy2-server',
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
            '-keyout /tmp/hy2-key.pem -out /tmp/hy2-cert.pem >/dev/null 2>&1 || exit 1; ' +
            'nft add table inet remnawave_hopping && nft -f /test/rules.nft || exit 1; ' +
            '/usr/local/bin/xray run -config /socks/xray.json >/tmp/xray.log 2>&1 & ' +
            '/usr/local/bin/sing-box run -c /test/server.json >/tmp/singbox.log 2>&1 & ' +
            'exec /usr/local/bin/gost -C /test/gost.json >/tmp/gost.log 2>&1',
    ]);

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    assertProcesses();

    for (const [name, config, hostPort, containerPort] of [
        [names.clientA, 'client-a.json', 12_080, 12_080],
        [names.clientB, 'client-b.json', 12_081, 12_081],
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
            `127.0.0.1:${hostPort}:${containerPort}`,
            '-v',
            `${temporaryDirectory}:/test:ro`,
            image,
            'run',
            '-c',
            `/test/${config}`,
        ]);
    }

    await Promise.all([waitForPort(12_080), waitForPort(12_081)]);
    const [userA, userB] = await Promise.all([measureDownload(12_080), measureDownload(12_081)]);
    assertProcesses();

    const beforeRestart = readUsedHopPorts();

    if (beforeRestart.userA.length < 2 || beforeRestart.userB.length < 2) {
        throw new Error(
            `Client did not demonstrate hopping across multiple ports: A=${beforeRestart.userA}, B=${beforeRestart.userB}\n${beforeRestart.nft}`,
        );
    }
    assertIndependentLimits(userA, userB, 'before Node restart');

    docker(['restart', '--timeout', '2', names.server]);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    assertProcesses();
    docker(['restart', '--timeout', '2', names.clientA, names.clientB]);
    await Promise.all([waitForPort(12_080), waitForPort(12_081)]);

    const [userAAfterRestart, userBAfterRestart] = await Promise.all([
        measureDownload(12_080),
        measureDownload(12_081),
    ]);
    assertProcesses();
    const afterRestart = readUsedHopPorts();
    if (afterRestart.userA.length < 2 || afterRestart.userB.length < 2) {
        throw new Error(
            `Stable allocations were not restored after Node restart: A=${afterRestart.userA}, B=${afterRestart.userB}\n${afterRestart.nft}`,
        );
    }
    assertIndependentLimits(userAAfterRestart, userBAfterRestart, 'after Node restart');

    console.log(
        JSON.stringify(
            {
                beforeRestart: {
                    userA,
                    userB,
                    usedHopPorts: { userA: beforeRestart.userA, userB: beforeRestart.userB },
                },
                afterRestart: {
                    userA: userAAfterRestart,
                    userB: userBAfterRestart,
                    usedHopPorts: { userA: afterRestart.userA, userB: afterRestart.userB },
                },
            },
            null,
            2,
        ),
    );
    console.log('PASS: real sing-box Hysteria2 clients hopped across per-user port ranges.');
    console.log(
        'PASS: real concurrent HY2 downloads retained independent 20/100 Mbps aggregate limits.',
    );
    console.log('PASS: Node restart restored the same ranges, ingress rules, and limiter buckets.');
    console.log('PASS: Xray, sing-box, and GOST remained running throughout the test.');
} catch (error) {
    for (const container of Object.values(names).filter((name) => name !== names.network)) {
        const logs = docker(['logs', container], { allowFailure: true, capture: true });
        if (logs.stdout || logs.stderr)
            console.error(`--- ${container}\n${logs.stdout}${logs.stderr}`);
    }
    throw error;
} finally {
    for (const container of [names.clientA, names.clientB, names.server, names.target]) {
        docker(['rm', '-f', container], { allowFailure: true, capture: true });
    }
    docker(['network', 'rm', names.network], { allowFailure: true, capture: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
}
