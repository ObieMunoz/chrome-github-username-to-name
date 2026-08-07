/**
 * Minimal chrome.storage stand-in so the real content script runs on this page
 * without installing the extension. Demo only — never shipped behaviour.
 */
(function () {
  'use strict';

  const { STORAGE_KEY } = globalThis.GHUN;

  let settings = {
    enabled: true,
    mappings: {
      u1069002: 'Obie Munoz',
      octocat: 'The Octocat',
    },
  };

  const listeners = [];

  window.chrome = {
    runtime: { id: 'demo-extension', lastError: null },
    storage: {
      sync: {
        get(key, callback) {
          setTimeout(() => callback({ [key]: settings }), 0);
        },
        set(items, callback) {
          const oldValue = settings;
          settings = items[STORAGE_KEY];
          for (const listener of listeners) {
            listener({ [STORAGE_KEY]: { newValue: settings, oldValue } }, 'sync');
          }
          if (callback) callback();
        },
      },
      onChanged: {
        addListener(listener) {
          listeners.push(listener);
        },
      },
    },
  };

  window.__demo = {
    get settings() {
      return settings;
    },
    update(patch) {
      window.chrome.storage.sync.set({ [STORAGE_KEY]: { ...settings, ...patch } });
    },
  };
})();
