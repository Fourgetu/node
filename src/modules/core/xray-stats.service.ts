import { Injectable } from '@nestjs/common';

import { XtlsApi } from '@remnawave/xtls-sdk';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';

import { PersistentTrafficStore } from './persistent-traffic-store';
import { ISingBoxStatsSnapshot } from './singbox-stats.service';

@Injectable()
export class XrayStatsService {
    private readonly persistentStore = new PersistentTrafficStore(
        process.env.XRAY_TRAFFIC_STATE_PATH ?? '/var/lib/rnode/stats/xray.json',
    );
    private readonly accumulated = this.persistentStore.values;
    private statsChain: Promise<void> = Promise.resolve();

    constructor(@InjectXtls() private readonly client: XtlsApi) {}

    public async accumulateAndReset(): Promise<void> {
        await this.runExclusive(async () => {
            const current = await this.queryRaw(true);
            for (const [name, value] of current) {
                this.accumulated.set(name, (this.accumulated.get(name) ?? 0) + value);
            }
            await this.persistentStore.save();
        });
    }

    public async getSnapshot(
        reset: boolean,
        resetPrefixes: string[],
    ): Promise<ISingBoxStatsSnapshot> {
        return await this.runExclusive(async () => {
            const current = await this.queryRaw(reset, resetPrefixes);
            const combined = new Map(this.accumulated);
            for (const [name, value] of current) {
                combined.set(name, (combined.get(name) ?? 0) + value);
            }

            if (reset) {
                this.accumulated.clear();
                for (const [name, value] of combined) {
                    if (!resetPrefixes.some((prefix) => name.startsWith(prefix))) {
                        this.accumulated.set(name, value);
                    }
                }
                await this.persistentStore.save();
            }

            return this.parseSnapshot(combined);
        });
    }

    private async queryRaw(reset: boolean, prefixes?: string[]): Promise<Map<string, number>> {
        const result = new Map<string, number>();
        const needs = (prefix: string) => !prefixes || prefixes.includes(prefix);

        if (needs('user>>>')) {
            const response = await this.client.stats.getAllUsersStats(reset);
            if (!response.isOk || !response.data) throw new Error('Failed to read Xray user stats');
            for (const user of response.data.users) {
                result.set(`user>>>${user.username}>>>traffic>>>uplink`, user.uplink);
                result.set(`user>>>${user.username}>>>traffic>>>downlink`, user.downlink);
            }
        }
        if (needs('inbound>>>')) {
            const response = await this.client.stats.getAllInboundsStats(reset);
            if (!response.isOk || !response.data)
                throw new Error('Failed to read Xray inbound stats');
            for (const inbound of response.data.inbounds) {
                result.set(`inbound>>>${inbound.inbound}>>>traffic>>>uplink`, inbound.uplink);
                result.set(`inbound>>>${inbound.inbound}>>>traffic>>>downlink`, inbound.downlink);
            }
        }
        if (needs('outbound>>>')) {
            const response = await this.client.stats.getAllOutboundsStats(reset);
            if (!response.isOk || !response.data)
                throw new Error('Failed to read Xray outbound stats');
            for (const outbound of response.data.outbounds) {
                result.set(`outbound>>>${outbound.outbound}>>>traffic>>>uplink`, outbound.uplink);
                result.set(
                    `outbound>>>${outbound.outbound}>>>traffic>>>downlink`,
                    outbound.downlink,
                );
            }
        }
        return result;
    }

    private parseSnapshot(stats: Map<string, number>): ISingBoxStatsSnapshot {
        const snapshot: ISingBoxStatsSnapshot = {
            inbounds: new Map(),
            outbounds: new Map(),
            users: new Map(),
        };
        for (const [name, value] of stats) {
            const match = /^(inbound|outbound|user)>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(
                name,
            );
            if (!match) continue;
            const [, category, tag, direction] = match;
            const target =
                category === 'inbound'
                    ? snapshot.inbounds
                    : category === 'outbound'
                      ? snapshot.outbounds
                      : snapshot.users;
            const item = target.get(tag) ?? { uplink: 0, downlink: 0 };
            item[direction as 'downlink' | 'uplink'] += value;
            target.set(tag, item);
        }
        return snapshot;
    }

    private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.statsChain.then(operation, operation);
        this.statsChain = result.then(
            () => void 0,
            () => void 0,
        );
        return await result;
    }
}
