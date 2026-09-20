import assert from 'node:assert/strict';
import test from 'node:test';

import { SingBoxService } from '../../src/modules/core/singbox.service';

test('last SS2022 user removal closes runtime listener and adding a user restores it without shared-password fallback', async () => {
    const key = Buffer.alloc(16, 7).toString('base64');
    const activated: { inbounds: { tag: string; users: unknown[] }[] }[] = [];
    const service = Object.assign(Object.create(SingBoxService.prototype), {
        currentConfig: {
            inbounds: [
                {
                    type: 'shadowsocks',
                    tag: 'ss',
                    method: '2022-blake3-aes-128-gcm',
                    password: Buffer.alloc(16, 9).toString('base64'),
                    users: [{ name: '1', password: key }],
                },
            ],
        },
        coreState: { isOnline: () => true },
        statsService: { accumulateAndReset: async () => {} },
        mutationChain: Promise.resolve(),
        apiListen: '127.0.0.1:19090',
        activateConfig: async (config: { inbounds: { tag: string; users: unknown[] }[] }) =>
            activated.push(config),
    }) as SingBoxService;
    await service.removeUsers(['1']);
    assert.deepEqual(activated[0].inbounds, []);
    assert.equal(service.hasInboundTag('ss'), true);
    await service.upsertUsers(['2'], [{ tag: 'ss', name: '2', password: key }]);
    assert.equal(activated[1].inbounds[0].tag, 'ss');
    assert.deepEqual(activated[1].inbounds[0].users, [{ name: '2', password: key }]);
});

test('sing-box add/disable/delete keeps per-user SS2022 keys and Vision flow without rewriting server keys', async () => {
    const inbounds = [
        {
            type: 'shadowsocks',
            tag: 'ss128',
            password: 'test-server-key',
            users: [] as Record<string, unknown>[],
        },
        { type: 'vless', tag: 'vision', users: [] as Record<string, unknown>[] },
    ];
    // Exercise the real mutation methods, replacing only persistence/reload IO.
    const service = Object.assign(Object.create(SingBoxService.prototype), {
        currentConfig: { inbounds },
        coreState: { isOnline: () => true },
        mutateUsers: async (mutate: (inbounds: object[]) => void) => mutate(inbounds),
    }) as SingBoxService;
    const keyA = Buffer.alloc(16, 1).toString('base64');
    const keyB = Buffer.alloc(16, 2).toString('base64');
    await service.upsertUsers(
        ['1', '2'],
        [
            { tag: 'ss128', name: '1', password: keyA },
            { tag: 'ss128', name: '2', password: keyB },
            {
                tag: 'vision',
                name: '1',
                uuid: '00000000-0000-4000-8000-000000000001',
                flow: 'xtls-rprx-vision',
            },
        ],
    );
    assert.deepEqual(inbounds[0].users, [
        { name: '1', password: keyA },
        { name: '2', password: keyB },
    ]);
    assert.equal(inbounds[0].password, 'test-server-key');
    assert.equal(inbounds[1].users[0].flow, 'xtls-rprx-vision');
    await service.removeUsers(['1']);
    assert.deepEqual(inbounds[0].users, [{ name: '2', password: keyB }]);
    assert.deepEqual(inbounds[1].users, []);
    await service.removeUsers(['2']);
    assert.deepEqual(inbounds[0].users, []);
});
