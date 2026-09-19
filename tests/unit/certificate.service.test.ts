import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    CertificateService,
    isManagedCertificatePair,
    PANEL_CERTIFICATE_URI,
    PANEL_PRIVATE_KEY_URI,
} from '../../src/modules/certificates/certificate.service.ts';

test('managed certificate markers are an exact pair', () => {
    assert.equal(isManagedCertificatePair(PANEL_CERTIFICATE_URI, PANEL_PRIVATE_KEY_URI), true);
    assert.equal(isManagedCertificatePair(PANEL_CERTIFICATE_URI, '/tmp/key.pem'), false);
    assert.equal(isManagedCertificatePair('/tmp/cert.pem', PANEL_PRIVATE_KEY_URI), false);
});

test('certificate sync fails closed for invalid certificate material', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remnawave-cert-'));
    process.env.REMNAWAVE_CERTIFICATE_DIR = directory;
    const service = new CertificateService();

    await assert.rejects(
        service.ensureInstalled({
            id: 'panel',
            hash: '0'.repeat(64),
            certificate: 'not-a-certificate',
            privateKey: 'not-a-private-key',
        }),
        /invalid|expired|match|PEM/i,
    );
});

test('certificate storage paths remain outside the xray config namespace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remnawave-cert-'));
    process.env.REMNAWAVE_CERTIFICATE_DIR = directory;
    const service = new CertificateService();

    await assert.rejects(
        service.ensureInstalled({
            id: 'panel',
            hash: 'f'.repeat(64),
            certificate: 'invalid',
            privateKey: 'invalid',
        }),
    );

    assert.equal((await stat(directory)).isDirectory(), true);
    assert.equal(await readFile(join(directory, 'missing'), 'utf8').catch(() => null), null);
});
