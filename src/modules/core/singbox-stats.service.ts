import { ChannelCredentials, createChannel, createClient } from 'nice-grpc';

import { Injectable } from '@nestjs/common';

import {
    QueryStatsResponse,
    StatsServiceDefinition,
    SysStatsResponse,
} from '@remnawave/xtls-sdk/build/src/xray-protos/app/stats/command/command';

import { PersistentTrafficStore } from './persistent-traffic-store';

interface ISingBoxStatsClient {
    getSysStats(request: Record<string, never>): Promise<SysStatsResponse>;
    queryStats(request: { pattern: string; reset: boolean }): Promise<QueryStatsResponse>;
}

interface ITrafficStat {
    downlink: number;
    uplink: number;
}

export interface ISingBoxStatsSnapshot {
    inbounds: Map<string, ITrafficStat>;
    outbounds: Map<string, ITrafficStat>;
    users: Map<string, ITrafficStat>;
}

const SINGBOX_STATS_SERVICE_DEFINITION = {
    ...StatsServiceDefinition,
    fullName: 'v2ray.core.app.stats.command.StatsService',
} as unknown as StatsServiceDefinition;

@Injectable()
export class SingBoxStatsService {
    private readonly client: ISingBoxStatsClient;
    private readonly persistentStore = new PersistentTrafficStore(
        process.env.SINGBOX_TRAFFIC_STATE_PATH ?? '/var/lib/rnode/stats/singbox.json',
    );
    private readonly accumulated = this.persistentStore.values;
    private statsChain: Promise<void> = Promise.resolve();

    constructor() {
        const listen = process.env.SINGBOX_API_LISTEN ?? '127.0.0.1:19090';
        const channel = createChannel(listen, ChannelCredentials.createInsecure(), {
            'grpc.max_receive_message_length': 100_000_000,
        });
        this.client = createClient(
            SINGBOX_STATS_SERVICE_DEFINITION,
            channel,
        ) as unknown as ISingBoxStatsClient;
    }

    public async getSysStats(): Promise<SysStatsResponse> {
        return await this.client.getSysStats({});
    }

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
        resetPrefixes?: string[],
    ): Promise<ISingBoxStatsSnapshot> {
        return await this.runExclusive(async () => {
            const current = await this.queryRaw(reset);
            const combined = new Map(this.accumulated);

            for (const [name, value] of current) {
                combined.set(name, (combined.get(name) ?? 0) + value);
            }

            if (reset) {
                this.accumulated.clear();
                if (resetPrefixes && resetPrefixes.length > 0) {
                    for (const [name, value] of combined) {
                        if (!resetPrefixes.some((prefix) => name.startsWith(prefix))) {
                            this.accumulated.set(name, value);
                        }
                    }
                }
                await this.persistentStore.save();
            }

            return this.parseSnapshot(combined);
        });
    }

    public async clear(): Promise<void> {
        await this.runExclusive(async () => {
            this.accumulated.clear();
            await this.persistentStore.save();
        });
    }

    private async queryRaw(reset: boolean): Promise<Map<string, number>> {
        const response = await this.client.queryStats({ pattern: '', reset });
        return new Map(response.stat.map((stat) => [stat.name, Number(stat.value)]));
    }

    private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.statsChain.then(operation, operation);
        this.statsChain = result.then(
            () => void 0,
            () => void 0,
        );
        return await result;
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
            item[direction as keyof ITrafficStat] += value;
            target.set(tag, item);
        }

        return snapshot;
    }
}
