/**
 * Finds the people a page links to and the names on their profiles, for the
 * popup's "Add from this page" view.
 *
 * Profiles are fetched from the page's own origin with the page's own session,
 * so this works for members only an org can see, and on an Enterprise host,
 * without a token. The name is read from the profile's `vcard-fullname`, or
 * failing that its `itemprop="name"` — microformat and schema.org markup GitHub
 * keeps for search engines, so it has reasons to stay put that a styling class
 * does not.
 */
(function () {
  'use strict';

  const { usernameFromUrl, usernameFromHovercardUrl, normalizeUsername } = globalThis.GHUN;

  /** Enough for an org's People page or a busy pull request, without hammering GitHub. */
  const MAX_PEOPLE = 100;
  const CONCURRENCY = 4;

  function currentMappings() {
    const engine = globalThis.GHUN_ENGINE;
    const settings = engine && engine.getSettings ? engine.getSettings() : null;
    return (settings && settings.mappings) || {};
  }

  /** @returns {string[]} unmapped usernames, in the case and order they first appear. */
  function collectUsernames(root) {
    const host = location.hostname;
    const mappings = currentMappings();
    const seen = new Set();
    const found = [];

    for (const el of root.querySelectorAll('a[href], [data-hovercard-url]')) {
      if (el.closest('[data-ghun-ui]')) continue;

      const annotated = el.getAttribute('data-hovercard-url');
      const username = annotated
        ? usernameFromHovercardUrl(annotated, host)
        : usernameFromUrl(el.getAttribute('href'), host);
      if (!username) continue;

      const key = normalizeUsername(username);
      if (seen.has(key) || mappings[key]) continue;
      seen.add(key);
      found.push(username);
    }
    return found;
  }

  /** @returns {string} the profile's own name, or '' when it has none beyond the login. */
  function profileNameFromHtml(html, username) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el = doc.querySelector('.vcard-fullname') || doc.querySelector('[itemprop="name"]');
    const name = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    return name && normalizeUsername(name) !== normalizeUsername(username) ? name : '';
  }

  async function fetchProfileName(username) {
    try {
      const response = await fetch(`/${encodeURIComponent(username)}`, { credentials: 'same-origin' });
      if (!response.ok) return '';
      return profileNameFromHtml(await response.text(), username);
    } catch {
      return '';
    }
  }

  /** Run `task` over `items` with at most `limit` running at once, keeping order. */
  async function mapLimited(items, limit, task) {
    const results = new Array(items.length);
    let next = 0;

    async function worker() {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await task(items[index]);
      }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  async function collectPeople() {
    const usernames = collectUsernames(document.body);
    const batch = usernames.slice(0, MAX_PEOPLE);
    const names = await mapLimited(batch, CONCURRENCY, fetchProfileName);

    return {
      people: batch.map((username, index) => ({ username, name: names[index] })),
      truncated: usernames.length > batch.length,
    };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'ghun:collect') return false;
      collectPeople().then(sendResponse, () => sendResponse({ people: [], truncated: false }));
      // Keeps the channel open for the asynchronous response.
      return true;
    });
  }

  globalThis.GHUN_COLLECT = {
    MAX_PEOPLE,
    CONCURRENCY,
    collectUsernames,
    profileNameFromHtml,
    collectPeople,
  };
})();
