/**
 * Minimal chrome.storage stand-in so the real content script runs on this page
 * without installing the extension. Demo only — never shipped behaviour.
 */
(function () {
  'use strict';

  const { packSettings, unpackSettings } = globalThis.GHUN;
  const store = globalThis.GHUN_STORE;

  const items = packSettings({
    enabled: true,
    color: null,
    mappings: {
      u1069002: 'Obie Munoz',
      octocat: 'The Octocat',
    },
  });

  const listeners = [];
  const copy = (value) => JSON.parse(JSON.stringify(value));

  function notify(changes) {
    for (const listener of listeners) listener(changes, 'sync');
  }

  const sync = {
    async get() {
      return copy(items);
    },
    async set(next) {
      const changes = {};
      for (const [key, value] of Object.entries(next)) {
        changes[key] = { oldValue: items[key], newValue: copy(value) };
        items[key] = copy(value);
      }
      notify(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const key of [].concat(keys)) {
        changes[key] = { oldValue: items[key] };
        delete items[key];
      }
      notify(changes);
    },
  };

  window.chrome = {
    runtime: { id: 'demo-extension', lastError: null, sendMessage: async () => {} },
    storage: {
      sync,
      onChanged: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
  };

  window.__demo = {
    get settings() {
      return unpackSettings(items);
    },
    update(patch) {
      return store.save(sync, { ...unpackSettings(items), ...patch });
    },
  };
})();
