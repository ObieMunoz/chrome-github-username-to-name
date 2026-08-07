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
      // Real chrome.storage supports both a callback and a promise; hovercard.js
      // uses the promise form and content.js the callback form, so match both.
      sync: {
        get(key, callback) {
          const value = { [key]: settings };
          if (typeof callback === 'function') {
            setTimeout(() => callback(value), 0);
            return undefined;
          }
          return Promise.resolve(value);
        },
        set(items, callback) {
          const oldValue = settings;
          settings = items[STORAGE_KEY];
          for (const listener of listeners) {
            listener({ [STORAGE_KEY]: { newValue: settings, oldValue } }, 'sync');
          }
          if (typeof callback === 'function') callback();
          return Promise.resolve();
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
