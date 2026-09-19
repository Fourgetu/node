import assert from 'node:assert/strict';
import test from 'node:test';

import { StartXrayCommand } from '../../libs/contract/commands/xray/start.command';

const baseRequest = {
    coreType: 'xray' as const,
    internals: {
        hashes: {
            emptyConfig: 'empty',
            inbounds: [],
        },
    },
    xrayConfig: {},
};

test('node-local contract keeps certificates optional', () => {
    assert.doesNotThrow(() => StartXrayCommand.RequestSchema.parse(baseRequest));
});

test('node-local contract validates managed certificates', () => {
    const result = StartXrayCommand.RequestSchema.parse({
        ...baseRequest,
        internals: {
            ...baseRequest.internals,
            certificates: [
                {
                    id: 'panel',
                    hash: 'a'.repeat(64),
                    certificate: 'certificate',
                    privateKey: 'private-key',
                },
            ],
        },
    });

    assert.equal(result.internals.certificates?.[0]?.privateKey, 'private-key');
});

test('node-local contract rejects malformed certificates', () => {
    assert.throws(() =>
        StartXrayCommand.RequestSchema.parse({
            ...baseRequest,
            internals: {
                ...baseRequest.internals,
                certificates: [
                    {
                        id: 'panel',
                        hash: 'invalid',
                        certificate: '',
                        privateKey: '',
                    },
                ],
            },
        }),
    );
});
