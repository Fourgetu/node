import assert from 'node:assert/strict';
import { basename, extname, join } from 'node:path';
import test from 'node:test';

import { createGostConfigSiblingPath } from '../../src/modules/gost/gost-forward-manager.service';

const configPath = join('var', 'lib', 'rnode', 'gost', 'config.json');

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
