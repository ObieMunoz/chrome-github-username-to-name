/**
 * Shared, dependency-free helpers.
 *
 * Loaded as a classic script in all three contexts (content script, popup,
 * service worker) and by the Node test suite, so it must not touch `window`,
 * `document`, or `chrome`.
 */
(function (root) {
  'use strict';

  /** Single storage key holding the whole settings object. */
  const STORAGE_KEY = 'ghun';

  const DEFAULT_SETTINGS = {
    enabled: true,
    /** lowercased username -> replacement text */
    mappings: {},
  };

  /**
   * Top-level github.com paths that look like a username but aren't one.
   * Only needs single-segment paths, since that's all we treat as a profile.
   */
  const RESERVED_PATHS = new Set([
    'about', 'account', 'apps', 'blog', 'business', 'codespaces', 'collections',
    'contact', 'copilot', 'customer-stories', 'dashboard', 'discussions',
    'education', 'enterprise', 'events', 'explore', 'features', 'home', 'issues',
    'join', 'login', 'logout', 'marketplace', 'new', 'nonprofit', 'notifications',
    'orgs', 'organizations', 'pages', 'pricing', 'pulls', 'readme', 'search',
    'security', 'session', 'settings', 'signup', 'site', 'sponsors', 'stars',
    'team', 'topics', 'trending', 'users', 'watching',
  ]);

  /**
   * GitHub usernames: alphanumeric plus single inner hyphens, max 39 chars.
   */
  const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

  function normalizeUsername(name) {
    return String(name == null ? '' : name).trim().replace(/^@+/, '').toLowerCase();
  }

  function isValidUsername(name) {
    return USERNAME_RE.test(String(name == null ? '' : name).trim());
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Build one regex matching any mapped username as a standalone token.
   *
   * `\b` is wrong here because usernames may contain hyphens, so the boundaries
   * are explicit lookarounds. The leading class also excludes `@`, `.`, `/` and
   * `_` so we don't match a username buried in an email address, a domain, or a
   * URL path; a genuine `@mention` still matches because the `@` is captured by
   * group 1, which sits after the lookbehind.
   *
   * The trailing `(?!\.[A-Za-z0-9])` separates a domain from punctuation: a dot
   * with more characters after it means `obiemunoz.com`, which must not match,
   * while a dot at the end of a sentence ("thanks u1069002.") still does.
   *
   * @returns {RegExp|null} null when there is nothing to match.
   */
  function buildMatcher(mappings) {
    const names = Object.keys(mappings || {}).filter(Boolean);
    if (!names.length) return null;

    // Longest first so overlapping names resolve to the more specific one.
    names.sort((a, b) => b.length - a.length || a.localeCompare(b));

    const alternation = names.map(escapeRegExp).join('|');
    return new RegExp(
      `(?<![A-Za-z0-9\\-@._/])(@?)(${alternation})(?![A-Za-z0-9\\-_])(?!\\.[A-Za-z0-9])`,
      'gi'
    );
  }

  /**
   * True for text that is (or contains) a URL, where rewriting the visible text
   * would make a link disagree with where it actually points.
   */
  function looksLikeUrl(text) {
    return text.includes('://') || /\bgithub\.com\//i.test(text);
  }

  /**
   * Pull a username out of a profile link. Only single-segment github.com paths
   * count, so `/owner/repo` and `/features` are both rejected.
   *
   * @returns {string|null} the username in its original case.
   */
  function usernameFromUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url), 'https://github.com');
    } catch {
      return null;
    }
    if (parsed.hostname && parsed.hostname !== 'github.com') return null;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 1) return null;

    const candidate = decodeURIComponent(segments[0]);
    if (!isValidUsername(candidate)) return null;
    if (RESERVED_PATHS.has(candidate.toLowerCase())) return null;
    return candidate;
  }

  /**
   * True for a link pointing at a repository's home page, e.g. `/octocat/hello`.
   *
   * A repo slug is an identifier rather than a reference to a person, so a repo
   * that happens to share its owner's name ("obiemunoz.com", or just
   * "obiemunoz") must keep reading literally. Exactly two segments is the point:
   * `/owner` stays replaceable, and deeper paths like `/owner/repo/pull/12` are
   * page titles that may legitimately mention someone.
   */
  function isRepoRootPath(url) {
    let parsed;
    try {
      parsed = new URL(String(url), 'https://github.com');
    } catch {
      return false;
    }
    if (parsed.hostname && parsed.hostname !== 'github.com') return false;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) return false;
    return !RESERVED_PATHS.has(segments[0].toLowerCase());
  }

  /**
   * Pull the username out of a hovercard endpoint, e.g. `/users/octocat/hovercard`.
   * This is the most reliable source available: it comes from the trigger element
   * GitHub itself annotates, rather than from the popup's markup.
   *
   * Organization hovercards use `/orgs/...` and are intentionally not matched.
   *
   * @returns {string|null} the username in its original case.
   */
  function usernameFromHovercardUrl(url) {
    const match = /^\/users\/([^/?#]+)\/hovercard/.exec(String(url || ''));
    if (!match) return null;

    const candidate = decodeURIComponent(match[1]);
    return isValidUsername(candidate) ? candidate : null;
  }

  /** Merge stored settings over the defaults, discarding malformed values. */
  function coerceSettings(stored) {
    const source = stored && typeof stored === 'object' ? stored : {};
    const mappings = {};

    if (source.mappings && typeof source.mappings === 'object') {
      for (const [username, replacement] of Object.entries(source.mappings)) {
        const key = normalizeUsername(username);
        const value = typeof replacement === 'string' ? replacement.trim() : '';
        if (key && value && isValidUsername(key)) mappings[key] = value;
      }
    }

    return {
      enabled: source.enabled !== false,
      mappings,
    };
  }

  /**
   * Read an exported file back into a mappings object.
   * Accepts both the wrapped export format and a bare `{username: name}` map.
   *
   * @returns {{mappings: Object, enabled: boolean|undefined}}
   * @throws {Error} with a message suitable for showing to the user.
   */
  function parseImport(json) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error("That file isn't valid JSON.");
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Expected a JSON object of usernames and names.');
    }

    const raw = data.mappings && typeof data.mappings === 'object' ? data.mappings : data;
    const mappings = {};
    let skipped = 0;

    for (const [username, replacement] of Object.entries(raw)) {
      const key = normalizeUsername(username);
      const value = typeof replacement === 'string' ? replacement.trim() : '';
      if (key && value && isValidUsername(key)) mappings[key] = value;
      else skipped += 1;
    }

    if (!Object.keys(mappings).length) {
      throw new Error('No usable username mappings found in that file.');
    }

    return { mappings, skipped, enabled: typeof data.enabled === 'boolean' ? data.enabled : undefined };
  }

  root.GHUN = {
    STORAGE_KEY,
    DEFAULT_SETTINGS,
    RESERVED_PATHS,
    normalizeUsername,
    isValidUsername,
    escapeRegExp,
    buildMatcher,
    looksLikeUrl,
    usernameFromUrl,
    isRepoRootPath,
    usernameFromHovercardUrl,
    coerceSettings,
    parseImport,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
