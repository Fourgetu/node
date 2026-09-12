import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { SingBoxStatsService } from '../../src/modules/core/singbox-stats.service';
import { XrayStatsService } from '../../src/modules/core/xray-stats.service';
import { StatsService } from '../../src/modules/stats/stats.service';

const stateDirectory = mkdtempSync(join(tmpdir(), 'remnawave-traffic-test-'));
let stateSequence = 0;
after(() => rmSync(stateDirectory, { recursive: true, force: true }));

interface FakeStat {
    name: string;
    value: bigint;
}

class FakeSingBoxStatsClient {
    private values = new Map<string, number>();

    add(name: string, value: number): void {
        this.values.set(name, (this.values.get(name) ?? 0) + value);
    }

    async getSysStats() {
        return {};
    }

    async queryStats({ reset }: { pattern: string; reset: boolean }) {
        const stat: FakeStat[] = Array.from(this.values, ([name, value]) => ({
            name,
            value: BigInt(value),
        }));
        if (reset) this.values.clear();
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { stat };
    }
}

const userStat = (direction: 'downlink' | 'uplink') => `user>>>42>>>traffic>>>${direction}`;
const inboundStat = (direction: 'downlink' | 'uplink') =>
    `inbound>>>singbox-hy2>>>traffic>>>${direction}`;
const outboundStat = (direction: 'downlink' | 'uplink') =>
    `outbound>>>direct>>>traffic>>>${direction}`;

const createSingBoxStats = (
    statePath = join(stateDirectory, `singbox-${stateSequence++}.json`),
) => {
    process.env.SINGBOX_TRAFFIC_STATE_PATH = statePath;
    const service = new SingBoxStatsService();
    const client = new FakeSingBoxStatsClient();
    (service as unknown as { client: FakeSingBoxStatsClient }).client = client;
    return { client, service };
};

class FakeXrayStatsClient {
    private users = new Map<string, { downlink: number; uplink: number }>();

    public addUser(username: string, uplink: number, downlink: number): void {
        const current = this.users.get(username) ?? { uplink: 0, downlink: 0 };
        current.uplink += uplink;
        current.downlink += downlink;
        this.users.set(username, current);
    }

    public readonly stats = {
        getAllUsersStats: async (reset: boolean) => {
            const users = Array.from(this.users, ([username, traffic]) => ({
                username,
                ...traffic,
            }));
            if (reset) this.users.clear();
            return { isOk: true, data: { users } };
        },
        getAllInboundsStats: async () => ({ isOk: true, data: { inbounds: [] } }),
        getAllOutboundsStats: async () => ({ isOk: true, data: { outbounds: [] } }),
    };
}

test('concurrent user and combined polling partitions one reset snapshot without loss or duplication', async () => {
    const { client, service } = createSingBoxStats();
    client.add(userStat('uplink'), 100_000_000);
    client.add(userStat('downlink'), 200_000_000);
    client.add(inboundStat('uplink'), 100_000_000);
    client.add(inboundStat('downlink'), 200_000_000);
    client.add(outboundStat('uplink'), 100_000_000);
    client.add(outboundStat('downlink'), 200_000_000);

    const [users, combined] = await Promise.all([
        service.getSnapshot(true, ['user>>>']),
        service.getSnapshot(true, ['inbound>>>', 'outbound>>>']),
    ]);

    assert.deepEqual(users.users.get('42'), { uplink: 100_000_000, downlink: 200_000_000 });
    assert.deepEqual(combined.inbounds.get('singbox-hy2'), {
        uplink: 100_000_000,
        downlink: 200_000_000,
    });
    assert.deepEqual(combined.outbounds.get('direct'), {
        uplink: 100_000_000,
        downlink: 200_000_000,
    });

    const drained = await service.getSnapshot(true, ['user>>>']);
    assert.equal(drained.users.size, 0, 'a second reset poll must not count the same bytes twice');
});

test('graceful sing-box reload snapshots counters and reports pre/post reload bytes exactly once', async () => {
    const { client, service } = createSingBoxStats();
    client.add(userStat('uplink'), 40_000_000);
    client.add(userStat('downlink'), 80_000_000);
    await service.accumulateAndReset();

    client.add(userStat('uplink'), 60_000_000);
    client.add(userStat('downlink'), 120_000_000);
    const snapshot = await service.getSnapshot(true, ['user>>>']);
    assert.deepEqual(snapshot.users.get('42'), {
        uplink: 100_000_000,
        downlink: 200_000_000,
    });
    assert.equal((await service.getSnapshot(true, ['user>>>'])).users.size, 0);
});

test('controlled Node restart restores Xray and sing-box snapshots exactly once from disk', async () => {
    const singBoxPath = join(stateDirectory, 'restart-singbox.json');
    const firstSingBox = createSingBoxStats(singBoxPath);
    firstSingBox.client.add(userStat('uplink'), 40_000_000);
    firstSingBox.client.add(userStat('downlink'), 80_000_000);
    await firstSingBox.service.accumulateAndReset();

    const restoredSingBox = createSingBoxStats(singBoxPath);
    const singBoxSnapshot = await restoredSingBox.service.getSnapshot(true, ['user>>>']);
    assert.deepEqual(singBoxSnapshot.users.get('42'), {
        uplink: 40_000_000,
        downlink: 80_000_000,
    });
    const drainedSingBox = createSingBoxStats(singBoxPath);
    assert.equal((await drainedSingBox.service.getSnapshot(true, ['user>>>'])).users.size, 0);

    const xrayPath = join(stateDirectory, 'restart-xray.json');
    process.env.XRAY_TRAFFIC_STATE_PATH = xrayPath;
    const firstXrayClient = new FakeXrayStatsClient();
    firstXrayClient.addUser('42', 60_000_000, 120_000_000);
    const firstXray = new XrayStatsService(firstXrayClient as never);
    await firstXray.accumulateAndReset();

    process.env.XRAY_TRAFFIC_STATE_PATH = xrayPath;
    const restoredXray = new XrayStatsService(new FakeXrayStatsClient() as never);
    const xraySnapshot = await restoredXray.getSnapshot(true, ['user>>>']);
    assert.deepEqual(xraySnapshot.users.get('42'), {
        uplink: 60_000_000,
        downlink: 120_000_000,
    });
    process.env.XRAY_TRAFFIC_STATE_PATH = xrayPath;
    const drainedXray = new XrayStatsService(new FakeXrayStatsClient() as never);
    assert.equal((await drainedXray.getSnapshot(true, ['user>>>'])).users.size, 0);
});

test('StatsService adds Xray and sing-box user traffic and has no GOST accounting source', async () => {
    const xrayStats = {
        getSnapshot: async () => ({
            users: new Map([['42', { uplink: 100_000_000, downlink: 0 }]]),
            inbounds: new Map(),
            outbounds: new Map(),
        }),
    };
    const singBox = {
        getSnapshot: async () => ({
            users: new Map([['42', { uplink: 0, downlink: 200_000_000 }]]),
            inbounds: new Map(),
            outbounds: new Map(),
        }),
    };
    const coreState = {
        getAll: () => ({
            xray: { online: true, version: 'test' },
            singbox: { online: true, version: 'test' },
        }),
    };
    const service = new StatsService(
        {} as never,
        {} as never,
        coreState as never,
        xrayStats as never,
        singBox as never,
    );
    const result = await service.getUsersStats(true);

    assert.equal(result.isOk, true);
    if (!result.isOk) return;
    assert.deepEqual(result.response.users, [
        { username: '42', uplink: 100_000_000, downlink: 200_000_000 },
    ]);
    assert.equal(
        Object.keys(service).some((key) => /gost/i.test(key)),
        false,
        'GOST must remain outside usedTraffic accounting',
    );
});
