/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.env.DUAL_CORE_IMAGE || 'remnawave-node-dualcore:amd64-test';
const suffix = process.pid;
const serverContainer = `remnawave-dual-hy2-server-${suffix}`;
const clientContainer = `remnawave-dual-hy2-client-${suffix}`;
const anyTlsClientContainer = `remnawave-dual-anytls-client-${suffix}`;
const targetContainer = `remnawave-dual-hy2-target-${suffix}`;
const network = `remnawave-dual-hy2-${suffix}`;
const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, '../runtime-fixtures/dual-core-hysteria2');
const socksFixtureDirectory = resolve(testDirectory, '../runtime-fixtures/dual-core-socks');

const docker = (args, options = {}) => {
    const result = spawnSync('docker', args, {
        encoding: 'utf8',
        stdio: options.capture ? 'pipe' : 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
        throw new Error(`docker ${args.join(' ')} failed with exit code ${result.status}`);
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
        socket.on('data', (chunk) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.flush();
        });
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
}

const transferHttpThroughClient = async (port) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.setTimeout(20_000, () => socket.destroy(new Error('Hysteria2 data transfer timed out')));
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
    if (reply[0] !== 5 || reply[1] !== 0) {
        throw new Error(`Hysteria2 SOCKS CONNECT failed with reply ${reply[1]}`);
    }
    const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await reader.read(1))[0];
    await reader.read(addressLength + 2);

    socket.write('GET / HTTP/1.1\r\nHost: http-target\r\nConnection: close\r\n\r\n');
    let response = '';
    while (!response.includes('\r\n')) response += (await reader.read(1)).toString();
    socket.destroy();

    if (!/^HTTP\/1\.[01] [23]\d\d /.test(response)) {
        throw new Error(`Unexpected HTTP response through Hysteria2: ${response}`);
    }
};

const assertServerProcesses = () => {
    const result = docker(
        [
            'exec',
            serverContainer,
            'sh',
            '-c',
            'for p in /proc/[0-9]*/comm; do cat "$p" 2>/dev/null; done',
        ],
        { capture: true },
    );
    for (const processName of ['xray', 'sing-box', 'gost']) {
        if (!result.stdout.split(/\r?\n/).includes(processName)) {
            throw new Error(`${processName} is not running during the Hysteria2 test`);
        }
    }
};

try {
    docker(['image', 'inspect', image], { capture: true });
    docker(['network', 'create', network]);
    docker([
        'run',
        '--rm',
        '--entrypoint',
        '/bin/sh',
        '-v',
        `${fixtureDirectory}:/fixtures:ro`,
        image,
        '-c',
        "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' " +
            '-keyout /tmp/hy2-key.pem -out /tmp/hy2-cert.pem >/dev/null 2>&1 && ' +
            '/usr/local/bin/sing-box check -c /fixtures/sing-box-server.json',
    ]);
    docker([
        'run',
        '--rm',
        '--entrypoint',
        '/usr/local/bin/sing-box',
        '-v',
        `${fixtureDirectory}:/fixtures:ro`,
        image,
        'check',
        '-c',
        '/fixtures/sing-box-client.json',
    ]);
    docker([
        'run',
        '--rm',
        '--entrypoint',
        '/usr/local/bin/sing-box',
        '-v',
        `${fixtureDirectory}:/fixtures:ro`,
        image,
        'check',
        '-c',
        '/fixtures/sing-box-anytls-client.json',
    ]);
    docker([
        'run',
        '--rm',
        '--entrypoint',
        '/usr/local/bin/gost',
        '-v',
        `${fixtureDirectory}:/fixtures:ro`,
        image,
        '-C',
        '/fixtures/gost.json',
        '-O',
        'json',
    ]);

    docker([
        'run',
        '--rm',
        '-d',
        '--network',
        network,
        '--network-alias',
        'http-target',
        '--name',
        targetContainer,
        '--entrypoint',
        'node',
        image,
        '-e',
        "require('node:http').createServer((q,s)=>{s.writeHead(200);s.end('dual-core-hysteria2-ok')}).listen(18080,'0.0.0.0')",
    ]);

    docker([
        'run',
        '--rm',
        '-d',
        '--network',
        network,
        '--network-alias',
        'hy2-server',
        '--name',
        serverContainer,
        '--entrypoint',
        '/bin/sh',
        '-v',
        `${fixtureDirectory}:/fixtures/hy2:ro`,
        '-v',
        `${socksFixtureDirectory}:/fixtures/socks:ro`,
        image,
        '-c',
        "openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' " +
            '-keyout /tmp/hy2-key.pem -out /tmp/hy2-cert.pem >/dev/null 2>&1 || exit 1; ' +
            '/usr/local/bin/xray run -config /fixtures/socks/xray.json >/tmp/xray.log 2>&1 & ' +
            '/usr/local/bin/sing-box run -c /fixtures/hy2/sing-box-server.json >/tmp/singbox.log 2>&1 & ' +
            'exec /usr/local/bin/gost -C /fixtures/hy2/gost.json >/tmp/gost.log 2>&1',
    ]);

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    assertServerProcesses();

    docker([
        'run',
        '--rm',
        '-d',
        '--network',
        network,
        '--name',
        clientContainer,
        '--entrypoint',
        '/usr/local/bin/sing-box',
        '-p',
        '127.0.0.1:12080:12080',
        '-v',
        `${fixtureDirectory}:/fixtures:ro`,
        image,
        'run',
        '-c',
        '/fixtures/sing-box-client.json',
    ]);

    await waitForPort(12080);
    await transferHttpThroughClient(12080);
    assertServerProcesses();

    docker([
        'run',
        '--rm',
        '-d',
        '--network',
        network,
        '--name',
        anyTlsClientContainer,
        '--entrypoint',
        '/usr/local/bin/sing-box',
        '-p',
        '127.0.0.1:12081:12081',
        '-v',
        `${fixtureDirectory}:/fixtures:ro`,
        image,
        'run',
        '-c',
        '/fixtures/sing-box-anytls-client.json',
    ]);

    await waitForPort(12081);
    await transferHttpThroughClient(12081);
    assertServerProcesses();

    console.log('PASS: a real sing-box Hysteria2 client completed a handshake through GOST UDP.');
    console.log('PASS: a real sing-box AnyTLS client transferred data through GOST TCP.');
    console.log('PASS: HTTP data transferred while Xray, sing-box, and GOST stayed running.');
} catch (error) {
    const runtimeLogs = docker(
        [
            'exec',
            serverContainer,
            'sh',
            '-c',
            'printf "XRAY\\n"; cat /tmp/xray.log; printf "SINGBOX\\n"; cat /tmp/singbox.log; printf "GOST\\n"; cat /tmp/gost.log',
        ],
        { allowFailure: true, capture: true },
    );
    if (runtimeLogs.stdout || runtimeLogs.stderr) {
        console.error(
            `--- ${serverContainer} runtimes\n${runtimeLogs.stdout}${runtimeLogs.stderr}`,
        );
    }
    for (const name of [serverContainer, clientContainer, anyTlsClientContainer, targetContainer]) {
        const logs = docker(['logs', name], { allowFailure: true, capture: true });
        if (logs.stdout || logs.stderr) console.error(`--- ${name}\n${logs.stdout}${logs.stderr}`);
    }
    throw error;
} finally {
    docker(['rm', '-f', anyTlsClientContainer], { allowFailure: true, capture: true });
    docker(['rm', '-f', clientContainer], { allowFailure: true, capture: true });
    docker(['rm', '-f', serverContainer], { allowFailure: true, capture: true });
    docker(['rm', '-f', targetContainer], { allowFailure: true, capture: true });
    docker(['network', 'rm', network], { allowFailure: true, capture: true });
}
