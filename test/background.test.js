'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const MANIFEST = JSON.parse(read('manifest.json'));

const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (listener) => listeners.push(listener),
    fire: (...args) => listeners.map((listener) => listener(...args)),
  };
}

/** Load the real service worker into a sandbox with a recording chrome stand-in. */
function setup({ items = {}, origins = ['https://github.com/*'], registered = [] } = {}) {
  const stored = plain(items);
  const badge = { text: [], colors: [] };
  const scripts = { registered: plain(registered), calls: [] };

  const chrome = {
    action: {
      setBadgeText: async (details) => badge.text.push(plain(details)),
      setBadgeBackgroundColor: async (details) => badge.colors.push(plain(details)),
      setBadgeTextColor: async () => {},
    },
    runtime: { onMessage: event(), onInstalled: event(), onStartup: event() },
    commands: { onCommand: event() },
    permissions: {
      getAll: async () => ({ origins: [...origins], permissions: [] }),
      onAdded: event(),
      onRemoved: event(),
    },
    scripting: {
      async getRegisteredContentScripts({ ids } = {}) {
        return plain(scripts.registered.filter((script) => !ids || ids.includes(script.id)));
      },
      async registerContentScripts(list) {
        scripts.calls.push(['register', plain(list)]);
        for (const script of list) {
          if (scripts.registered.some((existing) => existing.id === script.id)) {
            throw new Error(`Duplicate script ID '${script.id}'`);
          }
          scripts.registered.push(plain(script));
        }
      },
      async updateContentScripts(list) {
        scripts.calls.push(['update', plain(list)]);
        for (const script of list) {
          const index = scripts.registered.findIndex((existing) => existing.id === script.id);
          scripts.registered[index] = { ...scripts.registered[index], ...plain(script) };
        }
      },
      async unregisterContentScripts({ ids }) {
        scripts.calls.push(['unregister', ids]);
        scripts.registered = scripts.registered.filter((script) => !ids.includes(script.id));
      },
    },
    storage: {
      sync: {
        get: async () => plain(stored),
        async set(next) {
          Object.assign(stored, plain(next));
          chrome.storage.onChanged.fire(
            Object.fromEntries(Object.keys(next).map((key) => [key, { newValue: next[key] }])),
            'sync'
          );
        },
        async remove(keys) {
          for (const key of [].concat(keys)) delete stored[key];
        },
      },
      onChanged: event(),
    },
  };

  const context = vm.createContext({ chrome, console, setTimeout, importScripts: () => {} });
  vm.runInContext(read('src/common.js'), context);
  vm.runInContext(read('src/store.js'), context);
  vm.runInContext(read('src/background.js'), context);

  const settings = () => context.GHUN.unpackSettings(stored);
  const setOrigins = (next) => {
    origins = next;
  };
  return { chrome, badge, scripts, settings, setOrigins };
}

// --- badge -----------------------------------------------------------------

test('shows a tab’s replaced count on its badge', () => {
  const { chrome, badge } = setup();

  chrome.runtime.onMessage.fire({ type: 'ghun:count', count: 12 }, { tab: { id: 7 } });

  assert.deepEqual(badge.text.at(-1), { tabId: 7, text: '12' });
});

test('clears a tab’s own badge text when nothing was replaced', () => {
  const { chrome, badge } = setup();

  chrome.runtime.onMessage.fire({ type: 'ghun:count', count: 0 }, { tab: { id: 7 } });

  assert.deepEqual(badge.text.at(-1), { tabId: 7, text: null });
});

test('ignores counts that do not come from a tab', () => {
  const { chrome, badge } = setup();
  const before = badge.text.length;

  chrome.runtime.onMessage.fire({ type: 'ghun:count', count: 3 }, {});

  assert.equal(badge.text.length, before);
});

test('marks the badge "off" while paused', async () => {
  const { chrome, badge } = setup({ items: { ghun: { enabled: false, chunks: 0 } } });

  chrome.runtime.onStartup.fire();
  await settle();

  assert.deepEqual(badge.text.at(-1), { text: 'off' });
});

test('clears "off" when replacement is turned back on', async () => {
  const { chrome, badge } = setup({ items: { ghun: { enabled: false, chunks: 0 } } });

  await chrome.storage.sync.set({ ghun: { enabled: true, chunks: 0 } });
  await settle();

  assert.deepEqual(badge.text.at(-1), { text: '' });
});

test('ignores storage changes that are not its own', async () => {
  const { chrome, badge } = setup();
  const before = badge.text.length;

  chrome.storage.onChanged.fire({ other: { newValue: 1 } }, 'sync');
  await settle();

  assert.equal(badge.text.length, before);
});

// --- keyboard shortcut --------------------------------------------------------

test('the shortcut pauses replacement and keeps every name', async () => {
  const { chrome, settings } = setup({
    items: { ghun: { enabled: true, chunks: 1 }, 'ghun.m.0': { octocat: 'The Octocat' } },
  });

  chrome.commands.onCommand.fire('toggle-replacement');
  await settle();

  assert.equal(settings().enabled, false);
  assert.deepEqual(plain(settings().mappings), { octocat: 'The Octocat' });
});

test('the shortcut turns replacement back on', async () => {
  const { chrome, settings } = setup({ items: { ghun: { enabled: false, chunks: 0 } } });

  chrome.commands.onCommand.fire('toggle-replacement');
  await settle();

  assert.equal(settings().enabled, true);
});

test('declares the shortcut it listens for', () => {
  assert.ok(MANIFEST.commands['toggle-replacement']);
  assert.ok(MANIFEST.commands['toggle-replacement'].suggested_key.default);
});

// --- GitHub Enterprise hosts --------------------------------------------------

test('registers the content scripts for granted Enterprise hosts', async () => {
  const { chrome, scripts } = setup({
    origins: ['https://github.com/*', 'https://github.example.com/*'],
  });

  chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();

  assert.equal(scripts.registered.length, 1);
  assert.deepEqual(scripts.registered[0].matches, ['https://github.example.com/*']);
  assert.equal(scripts.registered[0].persistAcrossSessions, true);
});

test('registers the same files the manifest injects on github.com', async () => {
  const { chrome, scripts } = setup({ origins: ['https://github.example.com/*'] });

  chrome.runtime.onStartup.fire();
  await settle();

  const [declared] = MANIFEST.content_scripts;
  const [registered] = scripts.registered;
  assert.deepEqual(registered.js, declared.js);
  assert.deepEqual(registered.css, declared.css);
  assert.equal(registered.runAt, declared.run_at);
});

test('updates the registration when another host is granted', async () => {
  const { chrome, scripts, setOrigins } = setup({ origins: ['https://a.example.com/*'] });
  chrome.runtime.onStartup.fire();
  await settle();

  setOrigins(['https://a.example.com/*', 'https://b.example.com/*']);
  chrome.permissions.onAdded.fire({ origins: ['https://b.example.com/*'] });
  await settle();

  assert.equal(scripts.registered.length, 1);
  assert.deepEqual(scripts.registered[0].matches, [
    'https://a.example.com/*',
    'https://b.example.com/*',
  ]);
});

test('unregisters when the last Enterprise host is removed', async () => {
  const { chrome, scripts, setOrigins } = setup({ origins: ['https://a.example.com/*'] });
  chrome.runtime.onStartup.fire();
  await settle();

  setOrigins(['https://github.com/*']);
  chrome.permissions.onRemoved.fire({ origins: ['https://a.example.com/*'] });
  await settle();

  assert.deepEqual(scripts.registered, []);
});

test('registers nothing for github.com alone', async () => {
  const { chrome, scripts } = setup();

  chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();

  assert.deepEqual(scripts.calls, []);
});

test('overlapping events never register the same script twice', async () => {
  const { chrome, scripts } = setup({ origins: ['https://a.example.com/*'] });

  chrome.runtime.onInstalled.fire({ reason: 'update' });
  chrome.runtime.onStartup.fire();
  chrome.permissions.onAdded.fire({ origins: ['https://a.example.com/*'] });
  await settle();

  assert.equal(scripts.registered.length, 1);
  assert.equal(scripts.calls.filter(([kind]) => kind === 'register').length, 1);
});

test('asks for Enterprise hosts only when someone adds one', () => {
  assert.deepEqual(MANIFEST.host_permissions, ['https://github.com/*']);
  assert.deepEqual(MANIFEST.optional_host_permissions, ['https://*/*']);
  assert.ok(MANIFEST.permissions.includes('scripting'));
});
