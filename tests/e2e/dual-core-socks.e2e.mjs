/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const image = process.env.DUAL_CORE_IMAGE || 'remnawave-node-dualcore:amd64-test';
const container = `remnawave-dual-socks-e2e-${process.pid}`;
const fixtureDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../runtime-fixtures/dual-core-socks',
);

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
    const deadline = Date.now() + 15_000;
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

const encodeAuth = (username, password) => {
    const user = Buffer.from(username);
    const pass = Buffer.from(password);
    return Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]);
};

const openSocksTunnel = async ({ port, username, password, expectAuthSuccess }) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    await once(socket, 'connect');
    socket.setTimeout(10_000, () => socket.destroy(new Error('SOCKS test timed out')));
    const reader = new SocketReader(socket);

    socket.write(Buffer.from([5, 1, 2]));
    const greeting = await reader.read(2);
    if (!greeting.equals(Buffer.from([5, 2]))) {
        throw new Error(`SOCKS server on ${port} did not require username/password auth`);
    }

    socket.write(encodeAuth(username, password));
    const auth = await reader.read(2);
    const accepted = auth[0] === 1 && auth[1] === 0;
    if (accepted !== expectAuthSuccess) {
        throw new Error(`SOCKS auth result on ${port} was ${accepted ? 'accepted' : 'rejected'}`);
    }
    if (!accepted) {
        socket.destroy();
        return null;
    }

    const host = Buffer.from('example.com');
    socket.write(
        Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0, 80])]),
    );
    const reply = await reader.read(4);
    if (reply[0] !== 5 || reply[1] !== 0) {
        throw new Error(`SOCKS CONNECT on ${port} failed with reply ${reply[1]}`);
    }
    const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await reader.read(1))[0];
    await reader.read(addressLength + 2);
    return { socket, reader };
};

const expectHttpThroughSocks = async (options) => {
    const tunnel = await openSocksTunnel({ ...options, expectAuthSuccess: true });
    tunnel.socket.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');

    let response = tunnel.reader.buffer.toString();
    while (!response.includes('\r\n')) {
        response += (await tunnel.reader.read(1)).toString();
    }
    tunnel.socket.destroy();
    if (!/^HTTP\/1\.[01] [23]\d\d /.test(response)) {
        throw new Error(`Unexpected HTTP response through SOCKS port ${options.port}: ${response}`);
    }
};

try {
    docker(['image', 'inspect', image], { capture: true });
    docker([
        'run',
        '--rm',
        '--entrypoint',
        '/usr/local/bin/xray',
        '-v',
        `${fixtureDirectory}:/fixtures:ro`,
        image,
        'run',
        '-test',
        '-config',
        '/fixtures/xray.json',
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
        '/fixtures/sing-box.json',
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
        '--name',
        container,
        '--entrypoint',
        '/bin/sh',
        '-p',
        '127.0.0.1:32081:32081',
        '-p',
        '127.0.0.1:32082:32082',
        '-p',
        '127.0.0.1:32085:32085',
        '-p',
        '127.0.0.1:32086:32086',
        '-v',
        `${fixtureDirectory}:/fixtures:ro`,
        image,
        '-c',
        '/usr/local/bin/xray run -config /fixtures/xray.json >/tmp/xray.log 2>&1 & ' +
            '/usr/local/bin/sing-box run -c /fixtures/sing-box.json >/tmp/singbox.log 2>&1 & ' +
            'exec /usr/local/bin/gost -C /fixtures/gost.json >/tmp/gost.log 2>&1',
    ]);

    await Promise.all([
        waitForPort(32081),
        waitForPort(32082),
        waitForPort(32085),
        waitForPort(32086),
    ]);
    const processResult = docker(
        [
            'exec',
            container,
            'sh',
            '-c',
            'for p in /proc/[0-9]*/comm; do cat "$p" 2>/dev/null; done',
        ],
        { capture: true },
    );
    for (const processName of ['xray', 'sing-box', 'gost']) {
        if (!processResult.stdout.split(/\r?\n/).includes(processName)) {
            throw new Error(`${processName} is not running beside the other runtimes`);
        }
    }

    await expectHttpThroughSocks({ port: 32081, username: '101', password: 'xray-test-password' });
    await expectHttpThroughSocks({
        port: 32082,
        username: '102',
        password: 'singbox-test-password',
    });
    // A GOST service owns the limiter bucket, but both external ports terminate at the same
    // core inbound. The core authenticates the credential without knowing which UserRoute was
    // intended for it, so a valid credential can deliberately use another route's bucket.
    await expectHttpThroughSocks({ port: 32085, username: '101', password: 'xray-test-password' });
    await expectHttpThroughSocks({
        port: 32086,
        username: '102',
        password: 'singbox-test-password',
    });
    await openSocksTunnel({
        port: 32081,
        username: '101',
        password: 'wrong-password',
        expectAuthSuccess: false,
    });
    await openSocksTunnel({
        port: 32082,
        username: '102',
        password: 'wrong-password',
        expectAuthSuccess: false,
    });

    console.log('PASS: Xray SOCKS5 + sing-box SOCKS5 + GOST ran concurrently.');
    console.log('PASS: both authenticated TCP CONNECT paths transferred HTTP data.');
    console.log('PASS: both runtimes rejected invalid passwords.');
    console.log(
        'KNOWN LIMITATION CONFIRMED: credentials are not cryptographically bound to a UserRoute port.',
    );
} catch (error) {
    const logs = docker(['logs', container], { allowFailure: true, capture: true });
    if (logs.stdout || logs.stderr) console.error(logs.stdout, logs.stderr);
    throw error;
} finally {
    docker(['rm', '-f', container], { allowFailure: true, capture: true });
}
