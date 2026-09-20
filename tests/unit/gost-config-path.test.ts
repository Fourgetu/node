import assert from 'node:assert/strict';
import { basename, extname, join } from 'node:path';
import test from 'node:test';

import { SyncGostForwardsCommand } from '../../libs/contract/commands/gost/sync-forwards.command';
import {
    createGostConfigSiblingPath,
    GostForwardManager,
} from '../../src/modules/gost/gost-forward-manager.service';

const configPath = join('var', 'lib', 'rnode', 'gost', 'config.json');

test('TCP+UDP forwards use one shared route limiter and two native listeners on the same port', () => {
    const forwards = ['tcp', 'udp'].map((network) => ({
        id: '00000000-0000-4000-8000-000000000001',
        network,
        internalAddress: '127.0.0.1',
        internalPort: 23001,
        externalPort: 32001,
        downloadBytesPerSecond: 125000,
        uploadBytesPerSecond: 125000,
        enabled: true,
    }));
    assert.equal(SyncGostForwardsCommand.RequestSchema.safeParse({ forwards }).success, true);
    const manager = new GostForwardManager({} as never);
    const config = (
        manager as unknown as {
            buildConfig: (forwards: unknown[]) => {
                limiters: object[];
                services: {
                    name: string;
                    limiter: string;
                    addr: string;
                    handler: { type: string };
                }[];
            };
        }
    ).buildConfig(forwards);
    assert.equal(config.limiters.length, 1);
    assert.equal(config.services.length, 2);
    assert.notEqual(config.services[0].name, config.services[1].name);
    assert.equal(config.services[0].limiter, config.services[1].limiter);
    assert.equal(config.services[0].addr, config.services[1].addr);
    assert.deepEqual(
        config.services.map((service) => service.handler.type),
        ['tcp', 'udp'],
    );
});

test('GOST candidate config keeps JSON as its final extension', () => {
    const candidate = createGostConfigSiblingPath(configPath, 'tmp-119-1789272394204');

    assert.equal(basename(candidate), 'config.tmp-119-1789272394204.json');
    assert.equal(extname(candidate), '.json');
    assert.equal(candidate.includes('config.json.tmp-'), false);
});

test('GOST known-good and rollback siblings also keep the JSON extension', () => {
    const knownGood = createGostConfigSiblingPath(configPath, 'known-good');
    const restore = createGostConfigSiblingPath(configPath, 'restore-119-1789272394204');

    assert.equal(basename(knownGood), 'config.known-good.json');
    assert.equal(extname(knownGood), '.json');
    assert.equal(basename(restore), 'config.restore-119-1789272394204.json');
    assert.equal(extname(restore), '.json');
});
