/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const image = process.env.NODE_E2E_IMAGE ?? 'remnawave-node:gost-reconcile-e2e';
const container = `remnawave-gost-e2e-${randomUUID().slice(0, 8)}`;
const clientPath = fileURLToPath(new URL('./helpers/gost-reconcile-client.mjs', import.meta.url));

const run = (args, options = {}) => {
    const result = spawnSync('docker', args, {
        encoding: 'utf8',
        stdio: options.capture ? 'pipe' : 'inherit',
        ...options,
    });
    if (result.status !== 0) {
        throw new Error(
            `docker ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
        );
    }
    return result.stdout?.trim() ?? '';
};

const bootstrap = String.raw`
set -eu
fixture=/tmp/gost-e2e
mkdir -p "$fixture"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Remnawave E2E CA' -keyout "$fixture/ca.key" -out "$fixture/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' -keyout "$fixture/node.key" -out "$fixture/node.csr" >/dev/null 2>&1
openssl x509 -req -days 1 -in "$fixture/node.csr" -CA "$fixture/ca.crt" -CAkey "$fixture/ca.key" -CAcreateserial -out "$fixture/node.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=Remnawave E2E Client' -keyout "$fixture/client.key" -out "$fixture/client.csr" >/dev/null 2>&1
openssl x509 -req -days 1 -in "$fixture/client.csr" -CA "$fixture/ca.crt" -CAkey "$fixture/ca.key" -CAcreateserial -out "$fixture/client.crt" >/dev/null 2>&1
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$fixture/jwt.key" >/dev/null 2>&1
openssl pkey -in "$fixture/jwt.key" -pubout -out "$fixture/jwt.pub" >/dev/null 2>&1
SECRET_KEY=$(node -e "const fs=require('fs'); const d=process.argv[1]; const read=(n)=>fs.readFileSync(d+'/'+n,'utf8'); const value={caCertPem:read('ca.crt'),jwtPublicKey:read('jwt.pub'),nodeCertPem:read('node.crt'),nodeKeyPem:read('node.key')}; process.stdout.write(Buffer.from(JSON.stringify(value)).toString('base64'))" "$fixture")
export SECRET_KEY
node -e "const fs=require('fs'),crypto=require('crypto'); const d=process.argv[1]; const b=(v)=>Buffer.from(JSON.stringify(v)).toString('base64url'); const now=Math.floor(Date.now()/1000); const data=b({alg:'RS256',typ:'JWT'})+'.'+b({sub:'gost-e2e',iat:now,exp:now+3600}); const sig=crypto.sign('RSA-SHA256',Buffer.from(data),fs.readFileSync(d+'/jwt.key')).toString('base64url'); fs.writeFileSync(d+'/token',data+'.'+sig)" "$fixture"
printf '%s\n' '#!/bin/sh' 'if [ "$1" = "-C" ]; then case "$2" in *.tmp-*.json) sleep 0.3 ;; esac; fi' 'exec /usr/local/bin/gost "$@"' > "$fixture/gost-wrapper"
chmod 755 "$fixture/gost-wrapper"
exec /init /command/with-contenv node dist/main.js
`;

try {
    run([
        'run',
        '--detach',
        '--name',
        container,
        '--cap-add',
        'NET_ADMIN',
        '--env',
        'NODE_PORT=2222',
        '--env',
        'DISABLE_HASHED_SET_CHECK=true',
        '--env',
        'GOST_BINARY_PATH=/tmp/gost-e2e/gost-wrapper',
        '--entrypoint',
        '/bin/sh',
        image,
        '-c',
        bootstrap,
    ]);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        const ready = spawnSync('docker', ['exec', container, 'test', '-s', '/tmp/gost-e2e/token']);
        if (ready.status === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    run(['cp', clientPath, `${container}:/tmp/gost-reconcile-client.mjs`]);
    run(['exec', container, 'node', '/tmp/gost-reconcile-client.mjs']);

    const xrayState = run(
        ['exec', container, '/command/s6-svstat', '-o', 'up,pid', '/run/service/xray'],
        { capture: true },
    );
    const gostState = run(
        ['exec', container, '/command/s6-svstat', '-o', 'up,pid', '/run/service/gost'],
        { capture: true },
    );
    assert.match(xrayState, /^true\s+\d+$/);
    assert.match(gostState, /^true\s+\d+$/);

    const versions = run(
        [
            'exec',
            container,
            '/bin/sh',
            '-c',
            '/usr/local/bin/xray version | head -n 1; /usr/local/bin/sing-box version | head -n 1; /usr/local/bin/gost -V',
        ],
        { capture: true },
    );
    assert.match(versions, /Xray 26\.7\.28/);
    assert.match(versions, /sing-box version 1\.13\.14/);
    assert.match(versions, /gost v3\.3\.0/);

    const logs = run(['logs', container], { capture: true });
    assert.match(logs, /SECRET_KEY OK/);
    assert.equal(logs.includes('Unsupported Config Type'), false);
    assert.equal(logs.includes('config.json.tmp-'), false);

    console.log(`Node image: ${image}`);
    console.log(`Xray service: ${xrayState}`);
    console.log(`GOST service: ${gostState}`);
    console.log(versions);
    console.log('Node API and real GOST reconcile runtime: PASS');
} catch (error) {
    const logs = spawnSync('docker', ['logs', container], {
        encoding: 'utf8',
        stdio: 'pipe',
    });
    console.error(logs.stdout ?? '');
    console.error(logs.stderr ?? '');
    throw error;
} finally {
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
