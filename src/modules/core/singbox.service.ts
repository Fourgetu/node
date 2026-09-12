import ems from 'enhanced-ms';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import pRetry from 'p-retry';
import semver from 'semver';

import { Injectable, Logger } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { ok, TResult } from '@common/types';
import { getSystemInfo, getSystemStats } from '@common/utils/get-system-stats';
import { StartXrayCommand } from '@libs/contracts/commands';
import { CORE_TYPE } from '@libs/contracts/constants';

import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { StartXrayResponseModel, StopXrayResponseModel } from '../xray-core/models';
import { CoreStateService } from './core-state.service';
import { SingBoxProcessService } from './singbox-process.service';
import { SingBoxStatsService } from './singbox-stats.service';

const execFileAsync = promisify(execFile);
const SINGBOX_LOG_FILE = '/var/log/sing-box/current';

interface ISingBoxInbound extends Record<string, unknown> {
    tag?: string;
    type?: string;
    users?: Record<string, unknown>[];
}

interface ISingBoxConfig extends Record<string, unknown> {
    inbounds?: ISingBoxInbound[];
    outbounds?: Record<string, unknown>[];
    experimental?: Record<string, unknown>;
}

export interface ISingBoxUserMutation {
    tag: string;
    name: string;
    password?: string;
    uuid?: string;
    flow?: string;
}

@Injectable()
export class SingBoxService {
    private readonly logger = new Logger(SingBoxService.name);
    private readonly configPath = process.env.SINGBOX_CONFIG_PATH ?? '/run/remnawave/sing-box.json';
    private readonly singBoxPath = process.env.SINGBOX_PATH ?? '/usr/local/bin/sing-box';
    private readonly apiListen = process.env.SINGBOX_API_LISTEN ?? '127.0.0.1:19090';
    private readonly disableHashedSetCheck = process.env.DISABLE_HASHED_SET_CHECK === 'true';

    private isStartProcessing = false;
    private version: string | null = null;
    private currentConfig: ISingBoxConfig | null = null;
    private emptyConfigHash: string | null = null;
    private inboundHashes = new Map<string, string>();
    private mutationChain: Promise<void> = Promise.resolve();
    private readonly nodeVersion = __RWNODE_VERSION__ ?? '0.0.0';

    constructor(
        private readonly processService: SingBoxProcessService,
        private readonly statsService: SingBoxStatsService,
        private readonly coreState: CoreStateService,
        private readonly queryBus: QueryBus,
    ) {
        this.version = this.getVersionFromEnv();
    }

    public async start(
        body: StartXrayCommand.Request,
        ip: string,
    ): Promise<TResult<StartXrayResponseModel>> {
        const startedAt = performance.now();
        const system = await this.getSystem();

        if (this.isStartProcessing) {
            return ok(
                new StartXrayResponseModel(
                    false,
                    this.version,
                    'Request already in progress',
                    { version: this.nodeVersion },
                    system,
                    CORE_TYPE.SINGBOX,
                ),
            );
        }

        this.isStartProcessing = true;

        try {
            if (
                this.coreState.isOnline(CORE_TYPE.SINGBOX) &&
                !this.disableHashedSetCheck &&
                !body.internals.forceRestart
            ) {
                await this.statsService.getSysStats();
                if (!this.isRestartRequired(body.internals.hashes)) {
                    return ok(
                        new StartXrayResponseModel(
                            true,
                            this.version,
                            null,
                            { version: this.nodeVersion },
                            system,
                            CORE_TYPE.SINGBOX,
                        ),
                    );
                }
            }

            const fullConfig = this.injectManagementApi(body.xrayConfig);

            if (this.coreState.isOnline(CORE_TYPE.SINGBOX)) {
                await this.statsService.accumulateAndReset();
            }

            await this.activateConfig(fullConfig);
            this.rememberHashes(body.internals.hashes);
            this.currentConfig = fullConfig;
            this.version = await this.resolveVersion();
            this.coreState.setOnline(CORE_TYPE.SINGBOX, this.version);

            this.logger.log(
                `✔ sing-box v${this.version ?? 'unknown'} is up and running alongside Xray.`,
            );

            return ok(
                new StartXrayResponseModel(
                    true,
                    this.version,
                    null,
                    { version: this.nodeVersion },
                    system,
                    CORE_TYPE.SINGBOX,
                ),
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.coreState.setOffline(CORE_TYPE.SINGBOX);
            this.logger.error(`Failed to start sing-box: ${message}`);
            await this.dumpTailBlock(SINGBOX_LOG_FILE, 8);

            return ok(
                new StartXrayResponseModel(
                    false,
                    this.version,
                    message,
                    { version: this.nodeVersion },
                    system,
                    CORE_TYPE.SINGBOX,
                ),
            );
        } finally {
            this.logger.log(
                `Attempt to start sing-box took: ${ems(performance.now() - startedAt, {
                    extends: 'short',
                    includeMs: true,
                })} (IP: ${ip})`,
            );
            this.isStartProcessing = false;
        }
    }

    public async stop(): Promise<TResult<StopXrayResponseModel>> {
        try {
            if (this.coreState.isOnline(CORE_TYPE.SINGBOX)) {
                await this.statsService
                    .accumulateAndReset()
                    .catch((error) =>
                        this.logger.warn(`Failed to snapshot sing-box stats before stop: ${error}`),
                    );
            }

            await this.processService.stop();
            this.coreState.setOffline(CORE_TYPE.SINGBOX);
            this.currentConfig = null;
            this.emptyConfigHash = null;
            this.inboundHashes.clear();

            return ok(new StopXrayResponseModel(true));
        } catch (error) {
            this.logger.error(`Failed to stop sing-box: ${error}`);
            return ok(new StopXrayResponseModel(false));
        }
    }

    public getVersion(): string | null {
        return this.version;
    }

    public hasInboundTag(tag: string): boolean {
        return Boolean(this.currentConfig?.inbounds?.some((inbound) => inbound.tag === tag));
    }

    public async upsertUsers(usernames: string[], users: ISingBoxUserMutation[]): Promise<void> {
        if (!this.currentConfig || !this.coreState.isOnline(CORE_TYPE.SINGBOX)) return;

        const usernameSet = new Set(usernames);
        await this.mutateUsers((inbounds) => {
            for (const inbound of inbounds) {
                inbound.users = (inbound.users ?? []).filter(
                    (user) =>
                        !usernameSet.has(String(user.name)) &&
                        !usernameSet.has(String(user.username)),
                );
            }

            const inboundsByTag = new Map(
                inbounds
                    .filter((inbound) => typeof inbound.tag === 'string')
                    .map((inbound) => [inbound.tag!, inbound]),
            );

            for (const user of users) {
                const inbound = inboundsByTag.get(user.tag);
                if (!inbound) continue;

                inbound.users ??= [];
                switch (inbound.type) {
                    case 'anytls':
                    case 'hysteria2':
                    case 'trojan':
                    case 'shadowsocks':
                        inbound.users.push({ name: user.name, password: user.password });
                        break;
                    case 'socks':
                        inbound.users.push({ username: user.name, password: user.password });
                        break;
                    case 'vless':
                        inbound.users.push({
                            name: user.name,
                            uuid: user.uuid,
                            ...(user.flow ? { flow: user.flow } : {}),
                        });
                        break;
                }
            }
        });
    }

    public async removeUsers(usernames: string[]): Promise<void> {
        if (!this.currentConfig || !this.coreState.isOnline(CORE_TYPE.SINGBOX)) return;

        const usernameSet = new Set(usernames);
        await this.mutateUsers((inbounds) => {
            for (const inbound of inbounds) {
                inbound.users = (inbound.users ?? []).filter(
                    (user) =>
                        !usernameSet.has(String(user.name)) &&
                        !usernameSet.has(String(user.username)),
                );
            }
        });
    }

    private async mutateUsers(mutate: (inbounds: ISingBoxInbound[]) => void): Promise<void> {
        const execute = async () => {
            if (!this.currentConfig || !this.coreState.isOnline(CORE_TYPE.SINGBOX)) return;

            await this.statsService.accumulateAndReset();
            const nextConfig = structuredClone(this.currentConfig);
            mutate(nextConfig.inbounds ?? []);
            const managedConfig = this.injectManagementApi(nextConfig);
            await this.activateConfig(managedConfig);
            this.currentConfig = managedConfig;
        };

        const operation = this.mutationChain.then(execute, execute);
        this.mutationChain = operation.catch(() => void 0);
        await operation;
    }

    private isRestartRequired(hashes: StartXrayCommand.Request['internals']['hashes']): boolean {
        if (!this.emptyConfigHash || hashes.emptyConfig !== this.emptyConfigHash) return true;
        if (hashes.inbounds.length !== this.inboundHashes.size) return true;

        return hashes.inbounds.some(
            (inbound) => this.inboundHashes.get(inbound.tag) !== inbound.hash,
        );
    }

    private rememberHashes(hashes: StartXrayCommand.Request['internals']['hashes']): void {
        this.emptyConfigHash = hashes.emptyConfig;
        this.inboundHashes = new Map(hashes.inbounds.map((inbound) => [inbound.tag, inbound.hash]));
    }

    private injectManagementApi(config: Record<string, unknown>): ISingBoxConfig {
        const cloned = structuredClone(config) as ISingBoxConfig;
        const inbounds = cloned.inbounds ?? [];
        const outbounds = cloned.outbounds ?? [];
        const users = new Set<string>();

        for (const inbound of inbounds) {
            for (const user of inbound.users ?? []) {
                const username = user.name ?? user.username;
                if (typeof username === 'string') users.add(username);
            }
        }

        cloned.experimental = {
            ...cloned.experimental,
            v2ray_api: {
                listen: this.apiListen,
                stats: {
                    enabled: true,
                    inbounds: inbounds
                        .map((inbound) => inbound.tag)
                        .filter((tag): tag is string => typeof tag === 'string'),
                    outbounds: outbounds
                        .map((outbound) => outbound.tag)
                        .filter((tag): tag is string => typeof tag === 'string'),
                    users: Array.from(users),
                },
            },
        };

        return cloned;
    }

    private async activateConfig(config: ISingBoxConfig): Promise<void> {
        const temporaryPath = `${this.configPath}.tmp-${process.pid}-${Date.now()}`;
        const knownGoodPath = `${this.configPath}.known-good`;

        await mkdir(dirname(this.configPath), { recursive: true });
        await writeFile(temporaryPath, JSON.stringify(config, null, 2), {
            encoding: 'utf8',
            mode: 0o600,
        });

        try {
            await execFileAsync(this.singBoxPath, ['check', '-c', temporaryPath]);
            await rename(temporaryPath, this.configPath);
            await this.processService.restart();
            await this.waitUntilReady();
            await copyFile(this.configPath, knownGoodPath);
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => void 0);

            try {
                await copyFile(knownGoodPath, this.configPath);
                await this.processService.restart();
                await this.waitUntilReady();
                this.logger.warn('Restored the last known-good sing-box configuration.');
            } catch (restoreError) {
                this.logger.error(`sing-box rollback failed: ${restoreError}`);
            }

            throw error;
        }
    }

    private async waitUntilReady(): Promise<void> {
        await pRetry(
            async () => {
                const status = await this.processService.getStatus();
                if (!status.up) throw new Error('sing-box process is not up');
                await this.statsService.getSysStats();
            },
            { retries: 30, minTimeout: 100, maxTimeout: 2_000, factor: 1.5 },
        );
    }

    private async resolveVersion(): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync(this.singBoxPath, ['version']);
            return semver.valid(semver.coerce(stdout));
        } catch {
            return this.getVersionFromEnv();
        }
    }

    private getVersionFromEnv(): string | null {
        return semver.valid(semver.coerce(process.env.SINGBOX_CORE_VERSION));
    }

    private async getSystem() {
        const interfaceStats = await this.queryBus.execute(new GetInterfaceStatsQuery());
        return {
            info: getSystemInfo(),
            stats: getSystemStats(),
            interface: interfaceStats,
        };
    }

    private async dumpTailBlock(path: string, lines: number): Promise<void> {
        try {
            const { stdout } = await execFileAsync('tail', ['-n', String(lines), path]);
            const tail = stdout.split('\n').filter(Boolean);
            if (tail.length > 0) {
                this.logger.error(
                    ['sing-box Log Tail', ...tail.map((line) => `│ ${line}`)].join('\n'),
                );
            }
        } catch {
            // The first failed start may not have produced a log file yet.
        }
    }
}
