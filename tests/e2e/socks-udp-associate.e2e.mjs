/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.env.DUAL_CORE_IMAGE || 'remnawave-node-dualcore:amd64-hopping-test';
const suffix = process.pid;
const names = {
    network: `remnawave-socks-udp-${suffix}`,
    runtime: `remnawave-socks-udp-runtime-${suffix}`,
    target: `remnawave-socks-udp-target-${suffix}`,
};
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'remnawave-socks-udp-'));
const testDirectory = dirname(fileURLToPath(import.meta.url));
const helperDirectory = resolve(testDirectory, 'helpers');

const docker = (args, options = {}) => {
    const result = spawnSync('docker', args, {
        encoding: 'utf8',
        stdio: options.capture ? 'pipe' : 'inherit',
        timeout: 60_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
        throw new Error(
            `docker ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`,
        );
    }
    return result;
};

const credentials = { username: 'udp-user', password: 'udp-password' };
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
                accounts: [{ user: credentials.username, pass: credentials.password }],
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
            users: [credentials],
        },
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct' },
};
const gost = {
    limiters: [
        { name: 'xray-route', limits: ['$ 0B 2500000B'] },
        { name: 'singbox-route', limits: ['$ 0B 2500000B'] },
    ],
    services: [
        {
            name: 'xray-route',
            addr: '0.0.0.0:32301',
            limiter: 'xray-route',
            handler: { type: 'tcp' },
            listener: { type: 'tcp' },
            forwarder: { nodes: [{ name: 'xray', addr: '127.0.0.1:1080' }] },
        },
        {
            name: 'singbox-route',
            addr: '0.0.0.0:32302',
            limiter: 'singbox-route',
            handler: { type: 'tcp' },
            listener: { type: 'tcp' },
            forwarder: { nodes: [{ name: 'singbox', addr: '127.0.0.1:1081' }] },
        },
    ],
};

const runProbe = (containerArgs, expectSuccess) => {
    const result = docker(containerArgs, { allowFailure: !expectSuccess, capture: true });
    if (expectSuccess && result.status !== 0) throw new Error(result.stderr);
    if (!expectSuccess && result.status === 0) {
        throw new Error(`UDP unexpectedly traversed the TCP-only GOST UserRoute: ${result.stdout}`);
    }
    return result;
};

try {
    await Promise.all([
        writeFile(join(temporaryDirectory, 'xray.json'), JSON.stringify(xray, null, 2)),
        writeFile(join(temporaryDirectory, 'singbox.json'), JSON.stringify(singbox, null, 2)),
        writeFile(join(temporaryDirectory, 'gost.json'), JSON.stringify(gost, null, 2)),
    ]);
    docker(['image', 'inspect', image], { capture: true });
    docker(['network', 'create', names.network]);
    docker([
        'run',
        '--rm',
        '-d',
        '--network',
        names.network,
        '--network-alias',
        'udp-target',
        '--name',
        names.target,
        '--entrypoint',
        'node',
        image,
        '-e',
        "const d=require('node:dgram').createSocket('udp4');d.on('message',(m,r)=>d.send(m,r.port,r.address));d.bind(18081,'0.0.0.0')",
    ]);
    docker([
        'run',
        '--rm',
        '-d',
        '--network',
        names.network,
        '--network-alias',
        'runtime',
        '--name',
        names.runtime,
        '--entrypoint',
        '/bin/sh',
        '-v',
        `${temporaryDirectory}:/config:ro`,
        '-v',
        `${helperDirectory}:/helpers:ro`,
        image,
        '-c',
        '/usr/local/bin/xray run -config /config/xray.json >/tmp/xray.log 2>&1 & ' +
            '/usr/local/bin/sing-box run -c /config/singbox.json >/tmp/singbox.log 2>&1 & ' +
            'exec /usr/local/bin/gost -C /config/gost.json >/tmp/gost.log 2>&1',
    ]);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));

    for (const port of [1080, 1081]) {
        runProbe(
            [
                'exec',
                names.runtime,
                'node',
                '/helpers/socks-udp-client.mjs',
                '127.0.0.1',
                String(port),
                credentials.username,
                credentials.password,
                'udp-target',
                '18081',
            ],
            true,
        );
    }

    for (const port of [32_301, 32_302]) {
        runProbe(
            [
                'run',
                '--rm',
                '--network',
                names.network,
                '-v',
                `${helperDirectory}:/helpers:ro`,
                '--entrypoint',
                'node',
                image,
                '/helpers/socks-udp-client.mjs',
                'runtime',
                String(port),
                credentials.username,
                credentials.password,
                'udp-target',
                '18081',
            ],
            false,
        );
    }

    console.log(
        'PASS: Xray and sing-box authenticated UDP ASSOCIATE work at their direct core ingress.',
    );
    console.log(
        'UNSUPPORTED: the dynamic UDP relay is unreachable through a TCP-only GOST UserRoute.',
    );
    console.log("UNSUPPORTED: UDP datagrams therefore cannot use the route's GOST limiter bucket.");
} finally {
    docker(['rm', '-f', names.runtime, names.target], { allowFailure: true, capture: true });
    docker(['network', 'rm', names.network], { allowFailure: true, capture: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
}
