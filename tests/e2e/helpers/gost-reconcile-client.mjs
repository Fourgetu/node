/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { connect, createServer } from 'node:net';

const fixtureDirectory = '/tmp/gost-e2e';
const configDirectory = '/var/lib/rnode/gost';
const configPath = `${configDirectory}/config.json`;
const token = (await readFile(`${fixtureDirectory}/token`, 'utf8')).trim();
const tls = {
    ca: await readFile(`${fixtureDirectory}/ca.crt`),
    cert: await readFile(`${fixtureDirectory}/client.crt`),
    key: await readFile(`${fixtureDirectory}/client.key`),
};

const request = (method, path, body) =>
    new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = https.request(
            {
                ...tls,
                host: '127.0.0.1',
                port: 2222,
                path,
                method,
                checkServerIdentity: () => undefined,
                headers: {
                    authorization: `Bearer ${token}`,
                    ...(payload
                        ? {
                              'content-length': Buffer.byteLength(payload),
                              'content-type': 'application/json',
                          }
                        : {}),
                },
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (!response.statusCode || response.statusCode >= 300) {
                        reject(
                            new Error(`${method} ${path} returned ${response.statusCode}: ${text}`),
                        );
                        return;
                    }
                    resolve(text ? JSON.parse(text) : undefined);
                });
            },
        );
        req.once('error', reject);
        if (payload) req.write(payload);
        req.end();
    });

const waitForApi = async () => {
    const deadline = Date.now() + 60_000;
    let lastError;
    while (Date.now() < deadline) {
        try {
            await request('GET', '/node/gost/health');
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    throw lastError ?? new Error('Node API did not become ready');
};

const sync = async (forwards) => {
    const body = await request('POST', '/node/gost/sync-forwards', { forwards });
    return body.response;
};

const tcpRoundTrip = (port, payload) =>
    new Promise((resolve, reject) => {
        const socket = connect(port, '127.0.0.1');
        const chunks = [];
        socket.setTimeout(5_000, () => socket.destroy(new Error('TCP round trip timed out')));
        socket.once('connect', () => socket.write(payload));
        socket.on('data', (chunk) => {
            chunks.push(chunk);
            if (Buffer.concat(chunks).length >= payload.length) socket.end();
        });
        socket.once('error', reject);
        socket.once('close', () => {
            const result = Buffer.concat(chunks);
            try {
                assert.deepEqual(result, payload);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });

const udpRoundTrip = (port, payload) =>
    new Promise((resolve, reject) => {
        const socket = createSocket('udp4');
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error('UDP round trip timed out'));
        }, 5_000);
        socket.once('error', reject);
        socket.once('message', (message) => {
            clearTimeout(timer);
            socket.close();
            try {
                assert.deepEqual(message, payload);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
        socket.send(payload, port, '127.0.0.1');
    });

const tcpTarget = createServer((socket) => socket.pipe(socket));
await new Promise((resolve, reject) => {
    tcpTarget.once('error', reject);
    tcpTarget.listen(31_001, '127.0.0.1', resolve);
});

const udpTarget = createSocket('udp4');
udpTarget.on('message', (message, remote) => udpTarget.send(message, remote.port, remote.address));
await new Promise((resolve, reject) => {
    udpTarget.once('error', reject);
    udpTarget.bind(31_002, '127.0.0.1', resolve);
});

const tcpForward = {
    id: '00000000-0000-4000-8000-000000000101',
    externalPort: 32_001,
    internalAddress: '127.0.0.1',
    internalPort: 31_001,
    network: 'tcp',
    downloadBytesPerSecond: 100_000_000,
    uploadBytesPerSecond: 20_000_000,
    enabled: true,
};
const udpForward = {
    id: '00000000-0000-4000-8000-000000000102',
    externalPort: 32_002,
    internalAddress: '127.0.0.1',
    internalPort: 31_002,
    network: 'udp',
    downloadBytesPerSecond: 100_000_000,
    uploadBytesPerSecond: 20_000_000,
    enabled: true,
};

try {
    await waitForApi();

    const xray = (
        await request('POST', '/node/xray/start', {
            coreType: 'xray',
            internals: {
                forceRestart: true,
                hashes: { emptyConfig: 'gost-e2e', inbounds: [] },
            },
            xrayConfig: {
                log: { loglevel: 'warning' },
                inbounds: [],
                outbounds: [{ tag: 'DIRECT', protocol: 'freedom' }],
            },
        })
    ).response;
    assert.equal(xray.isStarted, true, xray.error ?? 'Xray failed to start');

    const empty = await sync([]);
    assert.equal(empty.applied, true);
    assert.equal(empty.services, 0);
    assert.match(empty.gostVersion, /3\.3\.0/);

    const tcp = await sync([tcpForward]);
    assert.equal(tcp.applied, true);
    assert.equal(tcp.services, 1);
    await tcpRoundTrip(32_001, Buffer.from('gost-tcp-e2e'));

    const udp = await sync([udpForward]);
    assert.equal(udp.applied, true);
    assert.equal(udp.services, 1);
    await udpRoundTrip(32_002, Buffer.from('gost-udp-e2e'));

    const multiple = await sync([tcpForward, udpForward]);
    assert.equal(multiple.applied, true);
    assert.equal(multiple.services, 2);
    await tcpRoundTrip(32_001, Buffer.from('gost-multiple-tcp'));
    await udpRoundTrip(32_002, Buffer.from('gost-multiple-udp'));

    for (const forward of [tcpForward, udpForward]) {
        const limiter = await readFile(
            `${configDirectory}/limiters/user-route-${forward.id}`,
            'utf8',
        );
        assert.equal(limiter, '$ 20000000B 100000000B\n');
    }

    const knownGoodBefore = await readFile(configPath, 'utf8');
    let corrupted = false;
    const corruptCandidate = setInterval(async () => {
        if (corrupted) return;
        const candidate = (await readdir(configDirectory)).find(
            (entry) => entry.startsWith('config.tmp-') && entry.endsWith('.json'),
        );
        if (!candidate) return;
        corrupted = true;
        await writeFile(`${configDirectory}/${candidate}`, '{ invalid json', 'utf8');
    }, 5);

    const rejected = await sync([{ ...tcpForward, externalPort: 32_003 }]);
    clearInterval(corruptCandidate);
    assert.equal(corrupted, true);
    assert.equal(rejected.applied, false);
    assert.ok(rejected.error);
    assert.equal(rejected.error.includes('Unsupported Config Type'), false);
    assert.equal(await readFile(configPath, 'utf8'), knownGoodBefore);

    const health = (await request('GET', '/node/gost/health')).response;
    assert.equal(health.running, true);
    assert.equal(health.services, 2);
    await tcpRoundTrip(32_001, Buffer.from('gost-rollback-tcp'));
    await udpRoundTrip(32_002, Buffer.from('gost-rollback-udp'));

    const entries = await readdir(configDirectory);
    assert.ok(entries.includes('config.known-good.json'));
    assert.equal(
        entries.some((entry) => entry.startsWith('config.json.tmp-')),
        false,
    );
    assert.equal(
        entries.some((entry) => entry.includes('.tmp-') && !entry.endsWith('.json')),
        false,
    );

    const explicitCandidate = `${configDirectory}/config.tmp-explicit-validation.json`;
    await writeFile(explicitCandidate, knownGoodBefore, 'utf8');
    const rendered = execFileSync('/usr/local/bin/gost', ['-C', explicitCandidate, '-O', 'json'], {
        encoding: 'utf8',
    });
    assert.match(rendered, /"services"/);

    console.log('GOST 3.3.0 candidate validation: PASS');
    console.log('empty desired state: PASS');
    console.log('TCP forward round trip: PASS');
    console.log('UDP forward round trip: PASS');
    console.log('multiple forwards and limiter datasource: PASS');
    console.log('invalid candidate rollback to known-good: PASS');
} finally {
    tcpTarget.close();
    udpTarget.close();
}
