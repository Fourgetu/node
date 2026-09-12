import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { SyncGostForwardsCommand } from '@libs/contracts/commands';

const execFileAsync = promisify(execFile);
const TABLE_FAMILY = 'inet';
const TABLE_NAME = 'remnawave_hopping';
const DEFAULT_RULESET_PATH = '/var/lib/rnode/gost/port-hopping.nft';

type GostForward = SyncGostForwardsCommand.Request['forwards'][number];

export interface PortHoppingRuntimeState {
    mode: 'disabled' | 'nftables';
    available: boolean;
    applied: boolean;
    requiresNetAdmin: true;
    rules: number;
    error: string | null;
}

@Injectable()
export class PortHoppingManager implements OnApplicationBootstrap {
    private readonly logger = new Logger(PortHoppingManager.name);
    private readonly nftPath = process.env.NFT_BINARY_PATH ?? '/usr/sbin/nft';
    private readonly rulesetPath = process.env.PORT_HOPPING_RULESET_PATH ?? DEFAULT_RULESET_PATH;
    private readonly mode: 'disabled' | 'nftables' =
        process.env.PORT_HOPPING_INGRESS === 'nftables' ? 'nftables' : 'disabled';
    private lastState: PortHoppingRuntimeState = this.baseState();

    public async onApplicationBootstrap(): Promise<void> {
        await mkdir(dirname(this.rulesetPath), { recursive: true, mode: 0o700 }).catch((error) =>
            this.logger.warn(`Unable to prepare port hopping directory: ${this.message(error)}`),
        );
    }

    public async sync(forwards: GostForward[]): Promise<PortHoppingRuntimeState> {
        const hopping = forwards.filter(
            (forward) =>
                forward.enabled &&
                forward.network === 'udp' &&
                forward.hopStartPort !== undefined &&
                forward.hopEndPort !== undefined,
        );

        if (this.mode === 'disabled') {
            this.lastState = {
                ...this.baseState(),
                rules: hopping.reduce(
                    (count, forward) =>
                        count + (forward.hopEndPort! - forward.hopStartPort! + 1),
                    0,
                ),
                error:
                    hopping.length > 0
                        ? 'Port hopping is configured but PORT_HOPPING_INGRESS=nftables is not enabled.'
                        : null,
            };
            return this.lastState;
        }

        if (!existsSync(this.nftPath)) {
            this.lastState = {
                ...this.baseState(),
                mode: 'nftables',
                error: `nft binary not found at ${this.nftPath}`,
            };
            return this.lastState;
        }

        for (const forward of hopping) this.validateForward(forward);
        const ruleset = this.buildRuleset(hopping);
        const temporaryPath = `${this.rulesetPath}.tmp-${process.pid}-${Date.now()}`;
        const knownGoodPath = `${this.rulesetPath}.known-good`;

        try {
            await writeFile(temporaryPath, ruleset, { encoding: 'utf8', mode: 0o600 });
            await this.ensureTable();
            await execFileAsync(this.nftPath, ['--check', '-f', temporaryPath], { timeout: 10_000 });
            await execFileAsync(this.nftPath, ['-f', temporaryPath], { timeout: 10_000 });
            await rename(temporaryPath, this.rulesetPath);
            await writeFile(knownGoodPath, ruleset, { encoding: 'utf8', mode: 0o600 });

            this.lastState = {
                mode: 'nftables',
                available: true,
                applied: true,
                requiresNetAdmin: true,
                rules: hopping.reduce(
                    (count, forward) =>
                        count + (forward.hopEndPort! - forward.hopStartPort! + 1),
                    0,
                ),
                error: null,
            };
        } catch (error) {
            const message = this.message(error);
            await this.restoreKnownGood(knownGoodPath);
            this.lastState = {
                mode: 'nftables',
                available: !this.isPermissionError(message),
                applied: false,
                requiresNetAdmin: true,
                rules: 0,
                error: this.isPermissionError(message)
                    ? `nftables requires an explicit NET_ADMIN grant: ${message}`
                    : message,
            };
            this.logger.error(`Port hopping ingress rejected: ${this.lastState.error}`);
        }
        return this.lastState;
    }

    public health(): PortHoppingRuntimeState {
        return this.lastState;
    }

    private baseState(): PortHoppingRuntimeState {
        return {
            mode: this.mode,
            available: this.mode === 'nftables' && existsSync(this.nftPath),
            applied: false,
            requiresNetAdmin: true,
            rules: 0,
            error: null,
        };
    }

    private validateForward(forward: GostForward): void {
        const start = forward.hopStartPort!;
        const end = forward.hopEndPort!;
        if (start > end) throw new Error(`Invalid hopping range ${start}-${end} for ${forward.id}.`);
        if (forward.externalPort >= start && forward.externalPort <= end) {
            throw new Error(`Canonical port ${forward.externalPort} overlaps hopping range.`);
        }
    }

    private buildRuleset(forwards: GostForward[]): string {
        const rules = forwards
            .map(
                (forward) =>
                    `    udp dport ${forward.hopStartPort}-${forward.hopEndPort} redirect to :${forward.externalPort} comment "route-${forward.id}"`,
            )
            .join('\n');
        const outputRules = forwards
            .map(
                (forward) =>
                    `    ip daddr 127.0.0.0/8 udp dport ${forward.hopStartPort}-${forward.hopEndPort} redirect to :${forward.externalPort} comment "route-${forward.id}"`,
            )
            .join('\n');

        return `flush table ${TABLE_FAMILY} ${TABLE_NAME}
add chain ${TABLE_FAMILY} ${TABLE_NAME} prerouting { type nat hook prerouting priority dstnat; policy accept; }
add chain ${TABLE_FAMILY} ${TABLE_NAME} output { type nat hook output priority dstnat; policy accept; }
${rules
    .split('\n')
    .filter(Boolean)
    .map((rule) => `add rule ${TABLE_FAMILY} ${TABLE_NAME} prerouting ${rule.trim()}`)
    .join('\n')}
${outputRules
    .split('\n')
    .filter(Boolean)
    .map((rule) => `add rule ${TABLE_FAMILY} ${TABLE_NAME} output ${rule.trim()}`)
    .join('\n')}
`;
    }

    private async ensureTable(): Promise<void> {
        try {
            await execFileAsync(this.nftPath, ['list', 'table', TABLE_FAMILY, TABLE_NAME], {
                timeout: 10_000,
            });
        } catch {
            await execFileAsync(this.nftPath, ['add', 'table', TABLE_FAMILY, TABLE_NAME], {
                timeout: 10_000,
            });
        }
    }

    private async restoreKnownGood(path: string): Promise<void> {
        try {
            const knownGood = await readFile(path, 'utf8');
            const restorePath = `${this.rulesetPath}.restore-${process.pid}-${Date.now()}`;
            await writeFile(restorePath, knownGood, { encoding: 'utf8', mode: 0o600 });
            await this.ensureTable();
            await execFileAsync(this.nftPath, ['-f', restorePath], { timeout: 10_000 });
        } catch {
            // A first-run failure has no prior hopping state to restore. The
            // canonical GOST listener remains untouched in either case.
        }
    }

    private isPermissionError(message: string): boolean {
        return /operation not permitted|permission denied|netlink/i.test(message);
    }

    private message(error: unknown): string {
        if (error instanceof Error) return error.message;
        return String(error);
    }
}
