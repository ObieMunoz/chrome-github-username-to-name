/**
 * Service worker: owns the "Replace this GitHub username…" context menu.
 *
 * The menu can't open the popup with data attached, so the username is parked
 * in local storage and the popup picks it up when it opens.
 */
importScripts('common.js');

const { PENDING_KEY, normalizeUsername, isValidUsername, usernameFromUrl } = globalThis.GHUN;

const MENU_ID = 'ghun-add-username';

/**
 * `targetUrlPatterns` is deliberately absent: it filters on an anchor's href, so
 * a selection right-click on plain text has nothing to match and Chrome drops
 * the item entirely. `documentUrlPatterns` already scopes us to github.com.
 */
function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Replace this GitHub username…',
      contexts: ['link', 'selection', 'page'],
      documentUrlPatterns: ['https://github.com/*'],
    });
  });
}

// Menus persist across service worker restarts, but re-registering on startup
// covers the case where the install event was missed or errored.
chrome.runtime.onInstalled.addListener(createMenu);
chrome.runtime.onStartup.addListener(createMenu);

/**
 * Prefer the link target, since a profile link is unambiguous. Fall back to the
 * selection so right-clicking plain username text still works.
 */
function resolveUsername(info) {
  const fromLink = info.linkUrl ? usernameFromUrl(info.linkUrl) : null;
  if (fromLink) return fromLink;

  const selected = normalizeUsername(info.selectionText);
  if (selected && isValidUsername(selected)) return selected;

  return null;
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID) return;

  const username = resolveUsername(info);
  if (!username) {
    // Nothing usable; open the popup empty rather than failing silently.
    await chrome.storage.local.remove(PENDING_KEY);
  } else {
    await chrome.storage.local.set({ [PENDING_KEY]: username });
  }

  try {
    await chrome.action.openPopup();
  } catch {
    // openPopup needs Chrome 127+ and an active window; fall back to a window.
    await chrome.windows.create({
      url: chrome.runtime.getURL('src/popup.html'),
      type: 'popup',
      width: 420,
      height: 600,
    });
  }
});
