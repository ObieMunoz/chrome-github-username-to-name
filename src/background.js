/**
 * Service worker: the toolbar badge, the pause shortcut, and the content
 * scripts for GitHub Enterprise hosts.
 *
 * Every listener is registered at the top level, as MV3 requires for a worker
 * that Chrome stops and restarts at will.
 */
importScripts('common.js', 'store.js');

(function () {
  'use strict';

  const { badgeText, customHosts, hostPattern } = globalThis.GHUN;
  const store = globalThis.GHUN_STORE;

  const BADGE_COLOR = '#1a7f37';
  const BADGE_OFF_COLOR = '#6e7681';

  /**
   * What the manifest injects on github.com, injected the same way on each
   * Enterprise host. The test suite holds the two lists to each other.
   */
  const HOST_SCRIPT = {
    id: 'ghun-enterprise',
    js: ['src/common.js', 'src/store.js', 'src/content.js', 'src/hovercard.js', 'src/collect.js'],
    css: ['src/content.css'],
    runAt: 'document_end',
    allFrames: false,
    persistAcrossSessions: true,
  };

  // --- badge -----------------------------------------------------------------

  /**
   * A tab's count is its own badge text; this is the global text underneath,
   * which shows wherever a tab has none. Pausing zeroes every tab's count, so
   * "off" is what every tab shows while paused.
   */
  async function refreshGlobalBadge() {
    const { enabled } = await store.load(chrome.storage.sync);
    await chrome.action.setBadgeBackgroundColor({ color: enabled ? BADGE_COLOR : BADGE_OFF_COLOR });
    await chrome.action.setBadgeText({ text: enabled ? '' : 'off' });
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== 'ghun:count') return false;
    if (!sender.tab || sender.tab.id == null) return false;
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: badgeText(message.count) });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !Object.keys(changes).some(store.isStoreKey)) return;
    refreshGlobalBadge().catch(console.error);
  });

  // --- keyboard shortcut -------------------------------------------------------

  chrome.commands.onCommand.addListener((command) => {
    if (command !== 'toggle-replacement') return;
    store
      .update(chrome.storage.sync, (settings) => {
        settings.enabled = !settings.enabled;
      })
      .catch(console.error);
  });

  // --- GitHub Enterprise hosts -------------------------------------------------

  /**
   * Make the registered content scripts match the hosts currently granted.
   *
   * Granted permissions are the only record of which hosts were added, so there
   * is nothing to drift out of step with them: a host removed from
   * chrome://extensions stops being served exactly as one removed in the popup.
   */
  async function reconcileHostScripts() {
    const { origins } = await chrome.permissions.getAll();
    const matches = customHosts(origins).map(hostPattern);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [HOST_SCRIPT.id] });

    if (!matches.length) {
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [HOST_SCRIPT.id] });
      return;
    }

    const script = { ...HOST_SCRIPT, matches };
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  }

  // Runs one at a time: install, startup and a permission change can all land
  // together, and two registrations of the same id would collide.
  let reconciling = Promise.resolve();

  function syncHostScripts() {
    reconciling = reconciling.then(reconcileHostScripts).catch(console.error);
    return reconciling;
  }

  function onLaunch() {
    syncHostScripts();
    refreshGlobalBadge().catch(console.error);
  }

  chrome.runtime.onInstalled.addListener(onLaunch);
  chrome.runtime.onStartup.addListener(onLaunch);
  chrome.permissions.onAdded.addListener(syncHostScripts);
  chrome.permissions.onRemoved.addListener(syncHostScripts);

  globalThis.GHUN_BACKGROUND = { HOST_SCRIPT, reconcileHostScripts, refreshGlobalBadge };
})();
