/**
 * Finds the people a page links to and the names on their profiles, for the
 * popup's "Add from this page" view.
 *
 * People are found by profile links, hovercard annotations, author-style
 * search filters (how the React issue and pull request lists link an author)
 * and avatars. A plain link can't tell a person from an organization or one of
 * GitHub's own pages, so only someone GitHub annotates as a user is taken on
 * trust; everyone else has to turn out to have a user's profile.
 *
 * Profiles are fetched from the page's own origin with the page's own session,
 * so this works for members only an org can see, and on an Enterprise host,
 * without a token. The name is read from the profile's `vcard-fullname`, or
 * failing that its `itemprop="name"`: microformat and schema.org markup GitHub
 * keeps for search engines, so it has reasons to stay put that a styling class
 * does not.
 */
(function () {
  'use strict';

  const { usernameFromUrl, usernameFromHovercardUrl, normalizeUsername, isValidUsername } = globalThis.GHUN;

  /** Enough for an org's People page or a busy pull request, without hammering GitHub. */
  const MAX_PEOPLE = 100;
  const CONCURRENCY = 4;

  /** GitHub's own header, menus and footer link to its pages and to the viewer, not to people on the page. */
  const SITE_CHROME = '.AppHeader, [role="banner"], nav, [role="navigation"], footer, [role="contentinfo"]';

  /** Search qualifiers whose value is a person, as in `/pulls?q=author:octocat`. */
  const PERSON_QUALIFIERS = ['author', 'assignee', 'commenter', 'involves', 'mentions', 'review-requested', 'reviewed-by'];
  const QUALIFIER_RE = new RegExp(`(?:^|\\s)(?:${PERSON_QUALIFIERS.join('|')}):(\\S+)`, 'g');

  function currentMappings() {
    const engine = globalThis.GHUN_ENGINE;
    const settings = engine && engine.getSettings ? engine.getSettings() : null;
    return (settings && settings.mappings) || {};
  }

  /** @returns {string[]} the people a search link filters by, on the page's own host. */
  function usernamesFromSearchUrl(url, host) {
    let parsed;
    try {
      parsed = new URL(String(url), location.href);
    } catch {
      return [];
    }
    if (parsed.hostname !== host) return [];

    const query = parsed.searchParams.get('q') || '';
    return Array.from(query.matchAll(QUALIFIER_RE), (match) => match[1]).filter(isValidUsername);
  }

  /** @returns {string|null} the login an avatar is labelled with. */
  function usernameFromAvatar(img) {
    if (!/avatars/.test(img.getAttribute('src') || '')) return null;
    const login = (img.getAttribute('alt') || '').trim().replace(/^@/, '');
    return isValidUsername(login) ? login : null;
  }

  /** @returns {{username: string, confirmed: boolean}[]} what an element says about who it shows. */
  function candidatesFrom(el, host) {
    const annotated = el.getAttribute('data-hovercard-url');
    if (annotated) {
      const username = usernameFromHovercardUrl(annotated, host);
      return username ? [{ username, confirmed: true }] : [];
    }
    if (el.tagName === 'IMG') {
      const username = usernameFromAvatar(el);
      return username ? [{ username, confirmed: false }] : [];
    }

    const href = el.getAttribute('href');
    const profile = usernameFromUrl(href, host);
    const usernames = profile ? [profile] : usernamesFromSearchUrl(href, host);
    return usernames.map((username) => ({ username, confirmed: false }));
  }

  /**
   * @returns {{username: string, confirmed: boolean}[]} unmapped people, in the
   *   case and order they first appear. `confirmed` marks those GitHub itself
   *   annotates as a user.
   */
  function collectCandidates(root) {
    const host = location.hostname;
    const mappings = currentMappings();
    const byKey = new Map();

    for (const el of root.querySelectorAll('a[href], [data-hovercard-url], img[alt]')) {
      if (el.closest('[data-ghun-ui]') || el.closest(SITE_CHROME)) continue;

      for (const candidate of candidatesFrom(el, host)) {
        const key = normalizeUsername(candidate.username);
        if (mappings[key]) continue;
        const known = byKey.get(key);
        if (known) known.confirmed = known.confirmed || candidate.confirmed;
        else byKey.set(key, candidate);
      }
    }
    return Array.from(byKey.values());
  }

  /** @returns {string[]} unmapped usernames, in the case and order they first appear. */
  function collectUsernames(root) {
    return collectCandidates(root).map((candidate) => candidate.username);
  }

  /**
   * A user's profile carries a `user:` hovercard subject and the login in its
   * vcard; an organization's carries `organization:`, and GitHub's own pages
   * neither.
   *
   * @returns {{name: string}|null} the profile's own name, '' when it has none
   *   beyond the login, or null when the page is not a user's profile.
   */
  function profileFromHtml(html, username) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const subject = doc.querySelector('meta[name="hovercard-subject-tag"]');
    const tag = subject ? subject.getAttribute('content') || '' : '';
    const isUser = /^user:/.test(tag) || (!tag && Boolean(doc.querySelector('.vcard-username, [itemprop="additionalName"]')));
    if (!isUser) return null;

    const el = doc.querySelector('.vcard-fullname') || doc.querySelector('[itemprop="name"]');
    const name = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    return { name: name && normalizeUsername(name) !== normalizeUsername(username) ? name : '' };
  }

  /**
   * @returns {Promise<{name: string}|null>} null only when GitHub says there is
   *   no such user. A request that fails for any other reason proves nothing,
   *   so it reads as a profile with no name.
   */
  async function fetchProfile(username) {
    try {
      const response = await fetch(`/${encodeURIComponent(username)}`, { credentials: 'same-origin' });
      if (response.status === 404) return null;
      if (!response.ok) return { name: '' };
      return profileFromHtml(await response.text(), username);
    } catch {
      return { name: '' };
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
    const candidates = collectCandidates(document.body);
    const batch = candidates.slice(0, MAX_PEOPLE);
    const profiles = await mapLimited(batch, CONCURRENCY, ({ username }) => fetchProfile(username));

    const people = [];
    batch.forEach(({ username, confirmed }, index) => {
      const profile = profiles[index];
      if (profile || confirmed) people.push({ username, name: profile ? profile.name : '' });
    });
    return { people, truncated: candidates.length > batch.length };
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
    profileFromHtml,
    collectPeople,
  };
})();
