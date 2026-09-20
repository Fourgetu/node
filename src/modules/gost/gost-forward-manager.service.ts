import { execFile, spawn, ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { ok, TResult } from '@common/types';
import { GetGostHealthCommand, SyncGostForwardsCommand } from '@libs/contracts/commands';

import { PortHoppingManager } from './port-hopping-manager.service';

const execFileAsync = promisify(execFile);

const DEFAULT_BINARY_PATH = '/usr/local/bin/gost';
const DEFAULT_CONFIG_PATH = '/var/lib/rnode/gost/config.json';
const DEFAULT_SERVICE_DIR = '/run/service/gost';
const S6_SVC = '/command/s6-svc';
const S6_SVSTAT = '/command/s6-svstat';
const CONFIG_TIMEOUT_MS = 10_000;
const RELOAD_WAIT_MS = 750;

type GostForward = SyncGostForwardsCommand.Request['forwards'][number];
type GostResponse = SyncGostForwardsCommand.Response['response'];
type GostHealthResponse = GetGostHealthCommand.Response['response'];

interface GostConfig {
    limiters: Array<{
        name: string;
        reload: string;
        file: { path: string };
    }>;
    services: Array<{
        name: string;
        addr: string;
        limiter: string;
        handler: { type: 'tcp' | 'udp' };
        listener: { type: 'tcp' | 'udp'; metadata?: { keepAlive: boolean } };
        forwarder: {
            nodes: Array<{ name: string; addr: string }>;
            selector: { strategy: string; maxFails: number; failTimeout: string };
        };
    }>;
}

interface LimiterSnapshot {
    files: Map<string, string>;
    paths: Set<string>;
}

export const createGostConfigSiblingPath = (configPath: string, suffix: string): string => {
    const filename = basename(configPath).replace(/\.json$/i, '');
    return join(dirname(configPath), `${filename}.${suffix}.json`);
};

@Injectable()
export class GostForwardManager implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(GostForwardManager.name);
    private readonly binaryPath = process.env.GOST_BINARY_PATH ?? DEFAULT_BINARY_PATH;
    private readonly configPath = process.env.GOST_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
    private readonly serviceDir = process.env.GOST_S6_SERVICE_DIR ?? DEFAULT_SERVICE_DIR;
    private readonly limiterDirectory = join(dirname(this.configPath), 'limiters');
    private directProcess: ChildProcess | null = null;
    private operation: Promise<unknown> = Promise.resolve();

    constructor(private readonly portHoppingManager: PortHoppingManager) {}

    public async onApplicationBootstrap(): Promise<void> {
        try {
            await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
            await mkdir(this.limiterDirectory, { recursive: true, mode: 0o700 });

            if (!(await this.fileExists(this.configPath))) {
                await writeFile(
                    this.configPath,
                    JSON.stringify({ services: [], limiters: [] }, null, 2),
                    { encoding: 'utf8', mode: 0o600 },
                );
            }
        } catch (error) {
            this.logger.warn(
                `GOST runtime directory preparation failed: ${this.formatError(error)}`,
            );
        }
    }

    public async syncForwards(
        request: SyncGostForwardsCommand.Request,
    ): Promise<TResult<GostResponse>> {
        return this.enqueue(async () => {
            const base = await this.getResponseBase(request.forwards.length);

            if (!base.installed) {
                return ok({
                    ...base,
                    applied: false,
                    error: `GOST binary not found at ${this.binaryPath}`,
                    portHopping: this.portHoppingManager.health(),
                });
            }

            const config = this.buildConfig(request.forwards.filter((forward) => forward.enabled));
            const configText = JSON.stringify(config, null, 2) + '\n';
            const tempConfigPath = createGostConfigSiblingPath(
                this.configPath,
                `tmp-${process.pid}-${Date.now()}`,
            );
            const backupConfigPath = createGostConfigSiblingPath(this.configPath, 'known-good');
            const limiterSnapshot = await this.snapshotLimiterFiles();
            const hadConfig = await this.fileExists(this.configPath);

            try {
                await writeFile(tempConfigPath, configText, { encoding: 'utf8', mode: 0o600 });
                await this.validate(tempConfigPath);

                if (hadConfig) {
                    await copyFile(this.configPath, backupConfigPath);
                }
                await rename(tempConfigPath, this.configPath);

                await this.writeLimiterFiles(request.forwards);
                await this.reloadOrStart();
                await this.verifyListeners(request.forwards.filter((forward) => forward.enabled));

                const running = await this.isRunning();
                if (!running) {
                    throw new Error('GOST did not remain running after configuration reload');
                }

                // Keep a persistent copy of the last configuration that was proven to run.
                await copyFile(this.configPath, backupConfigPath);
                const portHopping = await this.portHoppingManager.sync(
                    request.forwards.filter((forward) => forward.enabled),
                );

                return ok({
                    ...base,
                    applied: true,
                    running,
                    services: config.services.length,
                    error: null,
                    portHopping,
                });
            } catch (error) {
                await rm(tempConfigPath, { force: true }).catch(() => void 0);
                await this.restoreConfig(hadConfig, backupConfigPath);
                await this.restoreLimiterFiles(limiterSnapshot);
                await this.reloadOrStart().catch((restoreError) =>
                    this.logger.error(
                        `GOST known-good restore failed: ${this.formatError(restoreError)}`,
                    ),
                );

                const message = this.formatError(error);
                this.logger.error(`GOST configuration was rejected: ${message}`);

                return ok({
                    ...base,
                    applied: false,
                    running: await this.isRunning(),
                    error: message,
                    portHopping: this.portHoppingManager.health(),
                });
            }
        });
    }

    public async health(): Promise<TResult<GostHealthResponse>> {
        return this.enqueue(async () => {
            const base = await this.getResponseBase(0);
            return ok({
                running: await this.isRunning(),
                installed: base.installed,
                gostVersion: base.gostVersion,
                services: await this.readServiceCount(),
                configPath: this.configPath,
                error: base.installed ? null : `GOST binary not found at ${this.binaryPath}`,
                portHopping: this.portHoppingManager.health(),
            });
        });
    }

    public async onModuleDestroy(): Promise<void> {
        if (!this.directProcess) return;

        this.directProcess.kill('SIGTERM');
        this.directProcess = null;
    }

    private buildConfig(forwards: GostForward[]): GostConfig {
        return {
            // TCP+UDP services belonging to one User Route share a single limiter.
            limiters: [...new Map(forwards.map((forward) => [forward.id, forward])).values()].map(
                (forward) => {
                    const name = this.limiterName(forward.id);
                    return {
                        name,
                        reload: '5s',
                        file: { path: this.limiterPath(forward.id) },
                    };
                },
            ),
            services: forwards.map((forward) => {
                const limiter = this.limiterName(forward.id);
                const name = `${limiter}-${forward.network}`;
                const listener = {
                    type: forward.network,
                    ...(forward.network === 'udp' ? { metadata: { keepAlive: true } } : {}),
                } as GostConfig['services'][number]['listener'];

                return {
                    name,
                    addr: `0.0.0.0:${forward.externalPort}`,
                    limiter,
                    handler: { type: forward.network },
                    listener,
                    forwarder: {
                        nodes: [
                            {
                                name: 'xray',
                                addr: this.formatAddress(
                                    forward.internalAddress,
                                    forward.internalPort,
                                ),
                            },
                        ],
                        selector: { strategy: 'fifo', maxFails: 1, failTimeout: '10s' },
                    },
                };
            }),
        };
    }

    private async validate(path: string): Promise<void> {
        await execFileAsync(this.binaryPath, ['-C', path, '-O', 'json'], {
            timeout: CONFIG_TIMEOUT_MS,
            maxBuffer: 2 * 1024 * 1024,
        });
    }

    private async reloadOrStart(): Promise<void> {
        if (this.hasS6Control()) {
            if (!(await this.isRunning())) {
                await execFileAsync(S6_SVC, ['-u', this.serviceDir], {
                    timeout: CONFIG_TIMEOUT_MS,
                });
            } else {
                await execFileAsync(S6_SVC, ['-h', this.serviceDir], {
                    timeout: CONFIG_TIMEOUT_MS,
                });
            }

            await this.waitForRunning();
            return;
        }

        if (!this.directProcess || this.directProcess.exitCode !== null) {
            if (!existsSync(this.binaryPath)) {
                throw new Error(`GOST binary not found at ${this.binaryPath}`);
            }

            const child = spawn(this.binaryPath, ['-C', this.configPath, '-R', '5s'], {
                stdio: 'ignore',
            });
            child.once('error', (error) =>
                this.logger.error(`GOST process error: ${this.formatError(error)}`),
            );
            this.directProcess = child;
        } else {
            this.directProcess.kill('SIGHUP');
        }

        await this.waitForRunning();
    }

    private async waitForRunning(): Promise<void> {
        const deadline = Date.now() + CONFIG_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (await this.isRunning()) return;
            await new Promise((resolve) => setTimeout(resolve, RELOAD_WAIT_MS));
        }

        throw new Error('GOST process did not become ready in time');
    }

    private async verifyListeners(forwards: GostForward[]): Promise<void> {
        for (const forward of forwards) {
            const deadline = Date.now() + CONFIG_TIMEOUT_MS;
            let listening = false;

            while (Date.now() < deadline && !listening) {
                listening =
                    forward.network === 'tcp'
                        ? await this.canConnectTcp(forward.externalPort)
                        : await this.isUdpPortBound(forward.externalPort);
                if (!listening) {
                    await new Promise((resolve) => setTimeout(resolve, RELOAD_WAIT_MS));
                }
            }

            if (!listening) {
                throw new Error(
                    `GOST ${forward.network.toUpperCase()} listener did not bind 0.0.0.0:${forward.externalPort}`,
                );
            }
        }
    }

    private async canConnectTcp(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = createConnection({ host: '127.0.0.1', port });
            const finish = (result: boolean) => {
                socket.removeAllListeners();
                socket.destroy();
                resolve(result);
            };
            socket.setTimeout(1_000, () => finish(false));
            socket.once('connect', () => finish(true));
            socket.once('error', () => finish(false));
        });
    }

    private async isUdpPortBound(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = createSocket('udp4');
            socket.once('error', (error) => {
                try {
                    socket.close();
                } catch {
                    // A failed bind may already have closed the socket.
                }
                resolve((error as NodeJS.ErrnoException).code === 'EADDRINUSE');
            });
            socket.once('listening', () => {
                socket.close();
                resolve(false);
            });
            socket.bind(port, '0.0.0.0');
        });
    }

    private async isRunning(): Promise<boolean> {
        if (this.hasS6Control()) {
            try {
                const { stdout } = await execFileAsync(S6_SVSTAT, [
                    '-o',
                    'up,pid',
                    this.serviceDir,
                ]);
                return stdout.trim().split(/\s+/)[0] === 'true';
            } catch {
                return false;
            }
        }

        return this.directProcess !== null && this.directProcess.exitCode === null;
    }

    private hasS6Control(): boolean {
        return existsSync(join(this.serviceDir, 'supervise', 'control'));
    }

    private async getResponseBase(services: number): Promise<{
        running: boolean;
        installed: boolean;
        gostVersion: string | null;
        services: number;
        configPath: string;
    }> {
        const installed = await this.fileExists(this.binaryPath);
        return {
            running: await this.isRunning(),
            installed,
            gostVersion: installed ? await this.readVersion() : null,
            services,
            configPath: this.configPath,
        };
    }

    private async readVersion(): Promise<string | null> {
        try {
            const { stdout, stderr } = await execFileAsync(this.binaryPath, ['-V'], {
                timeout: CONFIG_TIMEOUT_MS,
                maxBuffer: 64 * 1024,
            });
            return (stdout || stderr).trim().split(/\r?\n/)[0] || null;
        } catch (error) {
            this.logger.warn(`Unable to read GOST version: ${this.formatError(error)}`);
            return null;
        }
    }

    private async readServiceCount(): Promise<number> {
        try {
            const config = JSON.parse(
                await readFile(this.configPath, 'utf8'),
            ) as Partial<GostConfig>;
            return Array.isArray(config.services) ? config.services.length : 0;
        } catch {
            return 0;
        }
    }

    private async snapshotLimiterFiles(): Promise<LimiterSnapshot> {
        const files = new Map<string, string>();
        const paths = new Set<string>();

        try {
            for (const entry of await readdir(this.limiterDirectory)) {
                const path = join(this.limiterDirectory, entry);
                const entryStat = await stat(path);
                if (!entryStat.isFile()) continue;
                paths.add(path);
                files.set(path, await readFile(path, 'utf8'));
            }
        } catch {
            // A missing directory is normal on the first sync.
        }

        return { files, paths };
    }

    private async writeLimiterFiles(forwards: GostForward[]): Promise<void> {
        await mkdir(this.limiterDirectory, { recursive: true, mode: 0o700 });
        const desired = new Set<string>();

        for (const forward of new Map(
            forwards.filter((item) => item.enabled).map((forward) => [forward.id, forward]),
        ).values()) {
            const path = this.limiterPath(forward.id);
            desired.add(path);
            const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
            // GOST's service-level traffic limiter uses input for client upload and output for
            // client download. Keep the source in bytes/sec; 0B is the unlimited sentinel.
            const line = `$ ${this.rate(forward.uploadBytesPerSecond)} ${this.rate(forward.downloadBytesPerSecond)}\n`;
            await writeFile(temp, line, { encoding: 'utf8', mode: 0o600 });
            await rename(temp, path);
        }

        for (const entry of await readdir(this.limiterDirectory)) {
            const path = join(this.limiterDirectory, entry);
            if (!desired.has(path) && !entry.includes('.tmp-')) {
                await rm(path, { force: true });
            }
        }
    }

    private async restoreLimiterFiles(snapshot: LimiterSnapshot): Promise<void> {
        await mkdir(this.limiterDirectory, { recursive: true, mode: 0o700 });
        for (const path of snapshot.paths) {
            const value = snapshot.files.get(path);
            if (value === undefined) continue;
            await writeFile(path, value, { encoding: 'utf8', mode: 0o600 });
        }

        for (const entry of await readdir(this.limiterDirectory)) {
            const path = join(this.limiterDirectory, entry);
            if (!snapshot.paths.has(path) && !entry.includes('.tmp-')) {
                await rm(path, { force: true });
            }
        }
    }

    private async restoreConfig(hadConfig: boolean, backupPath: string): Promise<void> {
        await rm(this.configPath, { force: true }).catch(() => void 0);
        if (hadConfig && (await this.fileExists(backupPath))) {
            const restorePath = createGostConfigSiblingPath(
                this.configPath,
                `restore-${process.pid}-${Date.now()}`,
            );
            await copyFile(backupPath, restorePath);
            await rename(restorePath, this.configPath);
        }
    }

    private limiterName(id: string): string {
        return `user-route-${id}`;
    }

    private limiterPath(id: string): string {
        return join(this.limiterDirectory, this.limiterName(id));
    }

    private rate(bytesPerSecond: number): string {
        return `${Math.trunc(bytesPerSecond)}B`;
    }

    private formatAddress(address: '127.0.0.1' | '::1', port: number): string {
        return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
    }

    private async fileExists(path: string): Promise<boolean> {
        try {
            const value = await stat(path);
            return value.isFile();
        } catch {
            return false;
        }
    }

    private formatError(error: unknown): string {
        if (error instanceof Error) return error.message;
        return String(error);
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.operation.then(operation, operation);
        this.operation = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }
}
