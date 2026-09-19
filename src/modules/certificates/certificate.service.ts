import { createHash, createPublicKey, timingSafeEqual, X509Certificate } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { StartXrayCommand } from '@libs/contracts/commands';

export const PANEL_CERTIFICATE_URI = 'remnawave://certificate/panel/fullchain.pem';
export const PANEL_PRIVATE_KEY_URI = 'remnawave://certificate/panel/privkey.pem';

export interface IInstalledCertificate {
    certificatePath: string;
    changed: boolean;
    hash: string;
    keyPath: string;
}

export type TCertificateBundle = NonNullable<
    StartXrayCommand.Request['internals']['certificates']
>[number];

export const isManagedCertificatePair = (certificatePath: unknown, keyPath: unknown): boolean =>
    certificatePath === PANEL_CERTIFICATE_URI && keyPath === PANEL_PRIVATE_KEY_URI;

const publicKeyDer = (value: ReturnType<typeof createPublicKey>): Buffer =>
    value.export({ type: 'spki', format: 'der' }) as Buffer;

const assertCertificateKeyPair = (certificate: string, privateKey: string): void => {
    const parsed = new X509Certificate(certificate);
    const certificatePublicKey = publicKeyDer(parsed.publicKey);
    const privateKeyPublicKey = publicKeyDer(createPublicKey(privateKey));
    if (
        certificatePublicKey.length !== privateKeyPublicKey.length ||
        !timingSafeEqual(certificatePublicKey, privateKeyPublicKey)
    ) {
        throw new Error('Managed TLS certificate and private key do not match.');
    }
    if (new Date(parsed.validTo).getTime() <= Date.now()) {
        throw new Error('Managed TLS certificate is expired.');
    }
};

@Injectable()
export class CertificateService {
    private readonly baseDirectory =
        process.env.REMNAWAVE_CERTIFICATE_DIR ?? '/var/lib/remnawave/certs';
    private readonly installedHashes = new Map<string, string>();

    public async ensureInstalled(bundle: TCertificateBundle): Promise<IInstalledCertificate> {
        assertCertificateKeyPair(bundle.certificate, bundle.privateKey);

        const expectedHash = createHash('sha256')
            .update(bundle.certificate)
            .update('\0')
            .update(bundle.privateKey)
            .digest('hex');
        if (expectedHash !== bundle.hash) {
            throw new Error('Managed TLS certificate hash is invalid.');
        }

        const id = this.sanitizeId(bundle.id);
        const directory = join(this.baseDirectory, id);
        const certificatePath = join(directory, 'fullchain.pem');
        const keyPath = join(directory, 'privkey.pem');
        const hashPath = join(directory, 'hash');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);

        let currentHash: string | undefined;
        try {
            currentHash = (await readFile(hashPath, 'utf8')).trim();
        } catch {
            currentHash = undefined;
        }
        if (currentHash === bundle.hash) {
            this.installedHashes.set(id, bundle.hash);
            return { certificatePath, keyPath, hash: bundle.hash, changed: false };
        }

        await this.atomicWrite(certificatePath, bundle.certificate, 0o644);
        await this.atomicWrite(keyPath, bundle.privateKey, 0o600);
        await this.atomicWrite(hashPath, bundle.hash, 0o600);
        this.installedHashes.set(id, bundle.hash);
        return { certificatePath, keyPath, hash: bundle.hash, changed: true };
    }

    public getInstalledHash(id: string): string | undefined {
        return this.installedHashes.get(this.sanitizeId(id));
    }

    private sanitizeId(value: string): string {
        const id = value.trim();
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid managed certificate id.');
        return id;
    }

    private async atomicWrite(path: string, content: string, mode: number): Promise<void> {
        const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
            handle = await open(temporaryPath, 'wx', mode);
            await handle.writeFile(content, { encoding: 'utf8' });
            await handle.sync();
            await handle.close();
            handle = undefined;
            await chmod(temporaryPath, mode);
            await rename(temporaryPath, path);
        } finally {
            await handle?.close().catch(() => void 0);
            await rm(temporaryPath, { force: true }).catch(() => void 0);
        }
    }
}
