'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/common.js');
require('../src/store.js');
const { STORAGE_KEY, CHUNK_PREFIX, ITEM_BYTE_BUDGET, packSettings, unpackSettings } = globalThis.GHUN;
const { load, save, update, isStoreKey } = globalThis.GHUN_STORE;

const plain = (value) => JSON.parse(JSON.stringify(value));

const itemBytes = (key, value) => new TextEncoder().encode(key + JSON.stringify(value)).length;

/** A stand-in for chrome.storage.sync that enforces the per-item cap Chrome does. */
function fakeArea(initial = {}) {
  const items = { ...initial };
  const calls = [];
  return {
    items,
    calls,
    async get(keys) {
      calls.push(['get', keys]);
      if (keys === null) return plain(items);
      const result = {};
      for (const key of [].concat(keys)) if (key in items) result[key] = plain(items[key]);
      return result;
    },
    async set(next) {
      calls.push(['set', Object.keys(next)]);
      for (const [key, value] of Object.entries(next)) {
        if (itemBytes(key, value) > 8192) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
      }
      Object.assign(items, plain(next));
    },
    async remove(keys) {
      calls.push(['remove', [].concat(keys)]);
      for (const key of [].concat(keys)) delete items[key];
    },
  };
}

function manyMappings(count) {
  const mappings = {};
  for (let i = 0; i < count; i += 1) mappings[`user-${i}`] = `Person Number ${i} Lastname`;
  return mappings;
}

test('packs a small settings object into the settings item and one chunk', () => {
  const items = packSettings({ enabled: true, color: null, mappings: { octocat: 'The Octocat' } });

  assert.deepEqual(plain(items[STORAGE_KEY]), { enabled: true, color: null, chunks: 1 });
  assert.deepEqual(plain(items[`${CHUNK_PREFIX}0`]), { octocat: 'The Octocat' });
});

test('packs no chunks when there are no mappings', () => {
  const items = packSettings({ enabled: false, color: '#ff0000', mappings: {} });

  assert.deepEqual(Object.keys(items), [STORAGE_KEY]);
  assert.equal(items[STORAGE_KEY].chunks, 0);
});

test('keeps every packed item under the per-item budget', () => {
  const items = packSettings({ enabled: true, color: null, mappings: manyMappings(1500) });

  assert.ok(items[STORAGE_KEY].chunks > 1);
  for (const [key, value] of Object.entries(items)) {
    assert.ok(itemBytes(key, value) <= ITEM_BYTE_BUDGET, `${key} is over budget`);
  }
});

test('measures the budget in bytes, so names outside ASCII cannot overflow a chunk', () => {
  const mappings = {};
  for (let i = 0; i < 400; i += 1) mappings[`user-${i}`] = '山田太郎さんの名前です';
  const items = packSettings({ enabled: true, color: null, mappings });

  for (const [key, value] of Object.entries(items)) {
    assert.ok(itemBytes(key, value) <= ITEM_BYTE_BUDGET, `${key} is over budget`);
  }
});

test('unpacks what it packed', () => {
  const settings = { enabled: false, color: '#123456', mappings: manyMappings(800) };
  const unpacked = unpackSettings(packSettings(settings));

  assert.deepEqual(plain(unpacked), settings);
});

test('reads the old single-item format, where mappings lived in the settings item', () => {
  const unpacked = unpackSettings({
    [STORAGE_KEY]: { enabled: true, color: null, mappings: { octocat: 'The Octocat' } },
  });

  assert.deepEqual(plain(unpacked.mappings), { octocat: 'The Octocat' });
});

test('ignores chunks past the count the settings item names', () => {
  // A chunk left behind by a larger save is stale until it is removed.
  const unpacked = unpackSettings({
    [STORAGE_KEY]: { enabled: true, color: null, chunks: 1 },
    [`${CHUNK_PREFIX}0`]: { octocat: 'The Octocat' },
    [`${CHUNK_PREFIX}1`]: { hubot: 'Hubot' },
  });

  assert.deepEqual(plain(unpacked.mappings), { octocat: 'The Octocat' });
});

test('falls back to defaults when nothing is stored', () => {
  assert.deepEqual(plain(unpackSettings({})), { enabled: true, mappings: {}, color: null });
});

test('recognises its own keys and nothing else', () => {
  assert.equal(isStoreKey(STORAGE_KEY), true);
  assert.equal(isStoreKey(`${CHUNK_PREFIX}3`), true);
  assert.equal(isStoreKey('ghunk'), false);
  assert.equal(isStoreKey('other'), false);
});

test('saves far more names than one 8KB item could hold', async () => {
  const area = fakeArea();
  const settings = { enabled: true, color: null, mappings: manyMappings(1500) };

  await save(area, settings);

  assert.deepEqual(plain(await load(area)), settings);
});

test('removes chunks a smaller save no longer needs', async () => {
  const area = fakeArea();
  await save(area, { enabled: true, color: null, mappings: manyMappings(1500) });
  await save(area, { enabled: true, color: null, mappings: { octocat: 'The Octocat' } });

  const chunkKeys = Object.keys(area.items).filter((key) => key.startsWith(CHUNK_PREFIX));
  assert.deepEqual(chunkKeys, [`${CHUNK_PREFIX}0`]);
});

test('writes every item in one set, so a reader never sees half a save', async () => {
  const area = fakeArea();
  await save(area, { enabled: true, color: null, mappings: manyMappings(1500) });

  assert.equal(area.calls.filter(([kind]) => kind === 'set').length, 1);
});

test('migrates the old format on the first save', async () => {
  const area = fakeArea({
    [STORAGE_KEY]: { enabled: true, color: null, mappings: { octocat: 'The Octocat' } },
  });

  await update(area, (settings) => {
    settings.mappings.hubot = 'Hubot';
  });

  assert.equal('mappings' in area.items[STORAGE_KEY], false);
  assert.deepEqual(plain((await load(area)).mappings), { octocat: 'The Octocat', hubot: 'Hubot' });
});

test('update reads the latest stored state before applying a change', async () => {
  const area = fakeArea();
  await save(area, { enabled: true, color: null, mappings: { octocat: 'The Octocat' } });

  await update(area, (settings) => {
    settings.enabled = false;
  });

  const stored = await load(area);
  assert.equal(stored.enabled, false);
  assert.deepEqual(plain(stored.mappings), { octocat: 'The Octocat' });
});

test('a failed save rejects so the caller can say so', async () => {
  const area = fakeArea();
  area.set = async () => {
    throw new Error('QUOTA_BYTES quota exceeded');
  };

  await assert.rejects(save(area, { enabled: true, color: null, mappings: {} }), /QUOTA_BYTES/);
});
