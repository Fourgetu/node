/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const image = process.env.PORT_HOPPING_IMAGE || 'remnawave-node-dualcore:amd64-hopping-test';
const container = `remnawave-port-hopping-${process.pid}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'remnawave-port-hopping-'));

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

const config = {
    limiters: [
        {
            name: 'user-a',
            limits: ['$ 0B 2500000B'],
        },
        {
            name: 'user-b',
            limits: ['$ 0B 12500000B'],
        },
    ],
    services: [
        {
            name: 'user-a-udp',
            addr: '127.0.0.1:32001',
            limiter: 'user-a',
            handler: { type: 'udp' },
            listener: { type: 'udp', metadata: { keepAlive: true } },
            forwarder: { nodes: [{ name: 'upstream', addr: '127.0.0.1:39000' }] },
        },
        {
            name: 'user-b-udp',
            addr: '127.0.0.1:32002',
            limiter: 'user-b',
            handler: { type: 'udp' },
            listener: { type: 'udp', metadata: { keepAlive: true } },
            forwarder: { nodes: [{ name: 'upstream', addr: '127.0.0.1:39000' }] },
        },
    ],
};

const rules = `flush table inet remnawave_hopping
add chain inet remnawave_hopping output { type nat hook output priority dstnat; policy accept; }
add rule inet remnawave_hopping output ip daddr 127.0.0.0/8 udp dport 20000-20019 redirect to :32001 comment "route-user-a"
add rule inet remnawave_hopping output ip daddr 127.0.0.0/8 udp dport 20020-20039 redirect to :32002 comment "route-user-b"
`;

const echoServer = `
const dgram = require('node:dgram');
const socket = dgram.createSocket('udp4');
socket.on('message', (message, remote) => socket.send(message, remote.port, remote.address));
socket.bind(39000, '127.0.0.1');
`;

const client = `
import dgram from 'node:dgram';

const payload = Buffer.alloc(1_200, 7);
const warmupMs = 2_000;
const measurementMs = 8_000;
const users = [
    { id: 'A', ports: [20001, 20008, 20015] },
    { id: 'B', ports: [20021, 20028, 20035] },
];

const sockets = users.flatMap((user) =>
    user.ports.map((port) => {
        const socket = dgram.createSocket('udp4');
        return { ...user, port, socket, bytes: 0, replies: 0, replyPorts: new Set() };
    }),
);

await Promise.all(
    sockets.map(
        (flow) =>
            new Promise((resolve, reject) => {
                flow.socket.once('error', reject);
                flow.socket.bind(0, '127.0.0.1', resolve);
            }),
    ),
);

let measuring = false;
for (const flow of sockets) {
    flow.socket.on('message', (message, remote) => {
        flow.replyPorts.add(remote.port);
        if (measuring) {
            flow.bytes += message.length;
            flow.replies += 1;
        }
    });
}

const sendTimer = setInterval(() => {
    for (const flow of sockets) {
        for (let index = 0; index < 12; index += 1) {
            flow.socket.send(payload, flow.port, '127.0.0.1');
        }
    }
}, 2);

await new Promise((resolve) => setTimeout(resolve, warmupMs));
for (const flow of sockets) {
    flow.bytes = 0;
    flow.replies = 0;
    flow.replyPorts.clear();
}
measuring = true;
const startedAt = performance.now();
await new Promise((resolve) => setTimeout(resolve, measurementMs));
measuring = false;
clearInterval(sendTimer);
const elapsedSeconds = (performance.now() - startedAt) / 1_000;
await new Promise((resolve) => setTimeout(resolve, 100));

const metrics = Object.fromEntries(
    users.map((user) => {
        const flows = sockets.filter((flow) => flow.id === user.id);
        const bytes = flows.reduce((sum, flow) => sum + flow.bytes, 0);
        return [
            user.id,
            {
                bytes,
                mbps: (bytes * 8) / elapsedSeconds / 1_000_000,
                ports: flows.map((flow) => ({
                    requested: flow.port,
                    replies: flow.replies,
                    replyPorts: [...flow.replyPorts],
                })),
            },
        ];
    }),
);

for (const flow of sockets) flow.socket.close();

for (const user of users) {
    for (const port of user.ports) {
        const flow = metrics[user.id].ports.find((item) => item.requested === port);
        if (!flow || flow.replies === 0) throw new Error('No UDP replies through hop port ' + port);
        if (!flow.replyPorts.includes(port)) {
            throw new Error(
                'Reverse NAT did not preserve hop port ' + port + ': ' + flow.replyPorts.join(','),
            );
        }
    }
}

if (metrics.A.mbps < 12 || metrics.A.mbps > 35) {
    throw new Error('User A aggregate rate outside 20 Mbps tolerance: ' + metrics.A.mbps);
}
if (metrics.B.mbps < 60 || metrics.B.mbps > 145) {
    throw new Error('User B aggregate rate outside 100 Mbps tolerance: ' + metrics.B.mbps);
}
if (metrics.B.mbps <= metrics.A.mbps * 2.5) {
    throw new Error('Per-user limiter buckets are not independent: ' + JSON.stringify(metrics));
}

console.log(JSON.stringify({ elapsedSeconds, metrics }, null, 2));
`;

try {
    await Promise.all([
        writeFile(join(temporaryDirectory, 'gost.json'), JSON.stringify(config, null, 2)),
        writeFile(join(temporaryDirectory, 'rules.nft'), rules),
        writeFile(join(temporaryDirectory, 'echo.cjs'), echoServer),
        writeFile(join(temporaryDirectory, 'client.mjs'), client),
    ]);

    docker(['image', 'inspect', image], { capture: true });
    const result = docker(
        [
            'run',
            '--rm',
            '--name',
            container,
            '--cap-add',
            'NET_ADMIN',
            '--entrypoint',
            '/bin/sh',
            '-v',
            `${temporaryDirectory}:/test:ro`,
            image,
            '-c',
            'set -u; nft add table inet remnawave_hopping && nft -f /test/rules.nft || exit 1; ' +
                'node /test/echo.cjs >/tmp/echo.log 2>&1 & echo_pid=$!; ' +
                '/usr/local/bin/gost -C /test/gost.json >/tmp/gost.log 2>&1 & gost_pid=$!; ' +
                'sleep 1; node /test/client.mjs; result=$?; ' +
                'kill "$gost_pid" "$echo_pid" 2>/dev/null || true; ' +
                'if [ "$result" -ne 0 ]; then cat /tmp/gost.log >&2; fi; exit "$result"',
        ],
        { capture: true, timeout: 45_000 },
    );
    console.log(result.stdout.trim());
    console.log('PASS: three hop ports for each user shared one canonical GOST limiter bucket.');
    console.log('PASS: aggregate user rates remained near 20 Mbps and 100 Mbps concurrently.');
} catch (error) {
    const logs = docker(['logs', container], { allowFailure: true, capture: true });
    if (logs.stdout || logs.stderr) console.error(`${logs.stdout}${logs.stderr}`);
    throw error;
} finally {
    docker(['rm', '-f', container], { allowFailure: true, capture: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
}
