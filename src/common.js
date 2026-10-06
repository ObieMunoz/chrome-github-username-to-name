/**
 * Shared, dependency-free helpers.
 *
 * Loaded as a classic script in all three contexts (content script, popup,
 * service worker) and by the Node test suite, so it must not touch `window`,
 * `document`, or `chrome`.
 */
(function (root) {
  'use strict';

  /** Storage key holding the settings, and the count of mapping chunks beside it. */
  const STORAGE_KEY = 'ghun';

  /** Mappings are spread over `ghun.m.0`, `ghun.m.1`, … so no one item hits the cap. */
  const CHUNK_PREFIX = 'ghun.m.';

  /**
   * chrome.storage.sync refuses any item over 8192 bytes, counted as the key
   * plus the value's JSON. With the whole map in one item that capped the
   * extension at a couple of hundred names, so each chunk is filled to just
   * under the cap instead, and the limit becomes sync's 100KB total.
   */
  const ITEM_BYTE_BUDGET = 8000;

  const DEFAULT_SETTINGS = {
    enabled: true,
    /** lowercased username -> replacement text */
    mappings: {},
    /** `#rrggbb` once the user picks a color, null while on the default. */
    color: null,
  };

  /**
   * What the wheel opens on before anything has been picked. content.css owns
   * the actual shipped default, which stays theme-aware; this is only the seed.
   */
  const DEFAULT_COLOR = '#39ff14';

  /** GitHub's page backgrounds, which the popup previews a color against. */
  const THEME_BACKGROUNDS = { dark: '#0d1117', light: '#ffffff' };

  /** WCAG AA for normal-size text. */
  const MIN_CONTRAST = 4.5;

  /**
   * Top-level github.com paths that look like a username but aren't one.
   * Only needs single-segment paths, since that's all we treat as a profile.
   */
  const RESERVED_PATHS = new Set([
    'about', 'account', 'apps', 'blog', 'business', 'codespaces', 'collections',
    'contact', 'copilot', 'customer-stories', 'dashboard', 'discussions',
    'education', 'enterprise', 'events', 'explore', 'features', 'feed', 'home', 'issues',
    'join', 'login', 'logout', 'marketplace', 'new', 'nonprofit', 'notifications',
    'orgs', 'organizations', 'pages', 'pricing', 'pulls', 'readme', 'repos', 'search',
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
   * Rejects a match that is really the local part of an email address.
   *
   * An address is an identifier rather than a reference to a person, so the
   * merge screen's `95655512+obiemunoz@users.noreply.github.com` has to stay
   * verbatim — a rewritten address is no longer the address.
   *
   * The other ways a username can sit in an address are already covered by the
   * boundaries in `buildMatcher`: a leading `.`, `-` or `_`, a trailing `-` or
   * `_`, and the domain side of `foo@user.example.com` all fail those. What is
   * left is the token running up to the `@`, either directly or through a
   * `+tag` suffix, which is what this rejects.
   */
  const EMAIL_LOCAL_PART = '(?!(?:\\+[A-Za-z0-9._+-]*)?@[A-Za-z0-9])';

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
   * A trailing `/` is excluded for the same reason as the leading one: the name
   * is the owner segment of a path, not a reference to a person. That is what
   * every merge commit's subject carries — "Merge pull request #4 from
   * ObieMunoz/feature/rewrites-code-blocks" — and a branch you can no longer
   * check out is the same broken copy-paste a code block would have been. A
   * breadcrumb spaces its slash out (`ObieMunoz / obiemunoz.com`), so the owner
   * there still reads as a person.
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
      `(?<![A-Za-z0-9\\-@._/])(@?)(${alternation})` +
        `(?![A-Za-z0-9\\-_/])(?!\\.[A-Za-z0-9])${EMAIL_LOCAL_PART}`,
      'gi'
    );
  }

  /**
   * The helpers below that read links take the host the page is served from, so
   * they work the same on a GitHub Enterprise host. Content scripts pass
   * `location.hostname`; anything empty means github.com.
   */
  const DEFAULT_HOST = 'github.com';

  function resolveUrl(url, host) {
    try {
      return new URL(String(url), `https://${host || DEFAULT_HOST}`);
    } catch {
      return null;
    }
  }

  /**
   * True for text that is (or contains) a URL, where rewriting the visible text
   * would make a link disagree with where it actually points.
   */
  function looksLikeUrl(text, host) {
    if (text.includes('://') || /\bgithub\.com\//i.test(text)) return true;
    return Boolean(host) && text.toLowerCase().includes(`${host.toLowerCase()}/`);
  }

  /**
   * Pull a username out of a profile link. Only single-segment paths on the
   * page's own host count, so `/owner/repo` and `/features` are both rejected.
   *
   * @returns {string|null} the username in its original case.
   */
  function usernameFromUrl(url, host) {
    const parsed = resolveUrl(url, host);
    if (!parsed || parsed.hostname !== (host || DEFAULT_HOST)) return null;

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
  function isRepoRootPath(url, host) {
    const parsed = resolveUrl(url, host);
    if (!parsed || parsed.hostname !== (host || DEFAULT_HOST)) return false;

    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) return false;
    return !RESERVED_PATHS.has(segments[0].toLowerCase());
  }

  /**
   * Pull the username out of a hovercard endpoint, e.g. `/users/octocat/hovercard`.
   * This is the most reliable source available: it comes from the trigger element
   * GitHub itself annotates, rather than from the popup's markup.
   *
   * Absolute forms of the same endpoint are accepted too, so the annotation
   * keeps working if GitHub ever renders it fully qualified.
   *
   * Organization hovercards use `/orgs/...` and are intentionally not matched.
   *
   * @returns {string|null} the username in its original case.
   */
  function usernameFromHovercardUrl(url, host) {
    let path = String(url || '');
    if (path.includes('://')) {
      const parsed = resolveUrl(path, host);
      if (!parsed || parsed.hostname !== (host || DEFAULT_HOST)) return null;
      path = parsed.pathname;
    }

    const match = /^\/users\/([^/?#]+)\/hovercard/.exec(path);
    if (!match) return null;

    const candidate = decodeURIComponent(match[1]);
    return isValidUsername(candidate) ? candidate : null;
  }

  /** One DNS label: letters, digits and inner hyphens. */
  const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

  /**
   * Turn what someone typed into the hostname of a GitHub Enterprise server.
   * A pasted URL is reduced to its host. github.com is built in, and only https
   * is served, so both are refused rather than silently changed.
   *
   * @returns {string|null}
   */
  function normalizeHost(input) {
    let text = String(input == null ? '' : input).trim().toLowerCase();
    if (!text) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
      if (!text.startsWith('https://')) return null;
    } else {
      text = `https://${text}`;
    }

    const parsed = resolveUrl(text);
    if (!parsed) return null;
    const host = parsed.hostname;
    if (!HOST_RE.test(host)) return null;
    if (host === DEFAULT_HOST || host.endsWith(`.${DEFAULT_HOST}`)) return null;
    return host;
  }

  function hostPattern(host) {
    return `https://${host}/*`;
  }

  /** The Enterprise hosts among granted origins, sorted, without github.com or wildcards. */
  function customHosts(origins) {
    const hosts = new Set();
    for (const origin of origins || []) {
      const match = /^https:\/\/([^/*]+)\/\*$/.exec(origin);
      if (match && match[1] !== DEFAULT_HOST) hosts.add(match[1]);
    }
    return Array.from(hosts).sort();
  }

  /**
   * Toolbar badge text for a count of replaced names. Null clears a tab's own
   * text so the badge falls back to the global one, which is how "off" shows.
   */
  function badgeText(count) {
    if (!(count > 0)) return null;
    return count > 999 ? '999+' : String(count);
  }

  /* --- color ---------------------------------------------------------------
   *
   * The user picks one color. Everything else — the counterpart variant for the
   * other theme, and the contrast maths behind it — is derived from that pick,
   * so there is only ever one value to store and one value to get wrong.
   * ------------------------------------------------------------------------ */

  /** @returns {{r: number, g: number, b: number}|null} */
  function parseHex(value) {
    const text = String(value == null ? '' : value).trim().replace(/^#/, '');
    // `#abc` is shorthand for `#aabbcc`.
    const full = text.length === 3 ? text.replace(/./g, (digit) => digit + digit) : text;
    if (!/^[0-9a-f]{6}$/i.test(full)) return null;

    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }

  function toHex({ r, g, b }) {
    const channel = (value) =>
      Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
    return `#${channel(r)}${channel(g)}${channel(b)}`;
  }

  /** @returns {string|null} the canonical `#rrggbb` form, or null if unparseable. */
  function normalizeHex(value) {
    const rgb = parseHex(value);
    return rgb ? toHex(rgb) : null;
  }

  /** @returns {{h: number, s: number, l: number}} hue in degrees, the rest 0..1. */
  function rgbToHsl({ r, g, b }) {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;

    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    const l = (max + min) / 2;

    // Grey: hue and saturation are both meaningless, so report a neutral.
    if (delta === 0) return { h: 0, s: 0, l };

    let h;
    if (max === red) h = (green - blue) / delta;
    else if (max === green) h = (blue - red) / delta + 2;
    else h = (red - green) / delta + 4;

    return {
      h: (h * 60 + 360) % 360,
      s: delta / (1 - Math.abs(2 * l - 1)),
      l,
    };
  }

  function hslToRgb({ h, s, l }) {
    const chroma = (1 - Math.abs(2 * l - 1)) * Math.min(1, Math.max(0, s));
    const sector = ((((h % 360) + 360) % 360) / 60);
    const second = chroma * (1 - Math.abs((sector % 2) - 1));
    const lightest = l - chroma / 2;

    const [r, g, b] =
      sector < 1 ? [chroma, second, 0] :
      sector < 2 ? [second, chroma, 0] :
      sector < 3 ? [0, chroma, second] :
      sector < 4 ? [0, second, chroma] :
      sector < 5 ? [second, 0, chroma] :
      [chroma, 0, second];

    return {
      r: Math.round((r + lightest) * 255),
      g: Math.round((g + lightest) * 255),
      b: Math.round((b + lightest) * 255),
    };
  }

  /** WCAG relative luminance. */
  function relativeLuminance({ r, g, b }) {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  /** WCAG contrast ratio between two hex colors, 1 (identical) to 21 (black on white). */
  function contrastRatio(foreground, background) {
    const fg = parseHex(foreground);
    const bg = parseHex(background);
    if (!fg || !bg) return 1;

    const a = relativeLuminance(fg);
    const b = relativeLuminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  /**
   * The stored form is just the hex the user picked, or null while on the
   * shipped default.
   *
   * One color, used on whichever theme GitHub happens to be showing. Deriving a
   * second variant per theme was tried and removed: it made a single pick into
   * two colors the user could not see at once, and the refit that produced the
   * second one is not reversible, so the machinery could quietly walk a chosen
   * color somewhere else. Anyone who switches theme and dislikes the result can
   * pick again, which is one click.
   *
   * @returns {string|null} a canonical `#rrggbb`, or null meaning "the default".
   */
  function coerceColor(value) {
    return typeof value === 'string' ? normalizeHex(value) : null;
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
      color: coerceColor(source.color),
    };
  }

  /** UTF-8 length, which is what the storage quota counts. */
  function byteLength(text) {
    let bytes = 0;
    for (const char of text) {
      const code = char.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return bytes;
  }

  /**
   * Lay settings out as the storage items they are saved as: the settings item,
   * naming how many chunks follow, and the chunks themselves.
   */
  function packSettings(settings) {
    const chunks = [];
    let current = {};
    // Room for the braces and the longest chunk key there will realistically be.
    const overhead = 2 + CHUNK_PREFIX.length + 6;
    let size = overhead;

    for (const username of Object.keys(settings.mappings).sort()) {
      const replacement = settings.mappings[username];
      const entry = byteLength(`${JSON.stringify(username)}:${JSON.stringify(replacement)},`);
      if (size + entry > ITEM_BYTE_BUDGET && size > overhead) {
        chunks.push(current);
        current = {};
        size = overhead;
      }
      current[username] = replacement;
      size += entry;
    }
    if (size > overhead) chunks.push(current);

    const items = {
      [STORAGE_KEY]: { enabled: settings.enabled, color: settings.color, chunks: chunks.length },
    };
    chunks.forEach((chunk, index) => {
      items[`${CHUNK_PREFIX}${index}`] = chunk;
    });
    return items;
  }

  /**
   * Reassemble settings from stored items. Chunks beyond the count the settings
   * item names are leftovers from a larger save and are ignored. The old format,
   * with every mapping inside the settings item, is still read.
   */
  function unpackSettings(items) {
    const source = items || {};
    const meta = source[STORAGE_KEY] && typeof source[STORAGE_KEY] === 'object' ? source[STORAGE_KEY] : {};
    const mappings = { ...(meta.mappings && typeof meta.mappings === 'object' ? meta.mappings : {}) };

    const count = Number.isInteger(meta.chunks) ? meta.chunks : 0;
    for (let index = 0; index < count; index += 1) {
      const chunk = source[`${CHUNK_PREFIX}${index}`];
      if (chunk && typeof chunk === 'object') Object.assign(mappings, chunk);
    }

    return coerceSettings({ enabled: meta.enabled, color: meta.color, mappings });
  }

  /** A refused storage write, put the way someone deciding what to do next needs it. */
  function describeSaveError(error) {
    const message = String((error && error.message) || error);
    if (/QUOTA_BYTES/.test(message)) {
      return 'Chrome sync storage is full. Remove a few names to make room.';
    }
    return `Could not save: ${message}`;
  }

  /**
   * Read pasted JSON back into a mappings object.
   * Accepts both the wrapped export format and a bare `{username: name}` map.
   *
   * @returns {{mappings: Object, enabled: boolean|undefined, color: Object|null}}
   * @throws {Error} with a message suitable for showing to the user.
   */
  function parseImport(json) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error("That isn't valid JSON.");
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
      throw new Error('No usable username mappings in that JSON.');
    }

    return {
      mappings,
      skipped,
      enabled: typeof data.enabled === 'boolean' ? data.enabled : undefined,
      color: coerceColor(data.color),
    };
  }

  root.GHUN = {
    STORAGE_KEY,
    CHUNK_PREFIX,
    ITEM_BYTE_BUDGET,
    DEFAULT_SETTINGS,
    DEFAULT_COLOR,
    THEME_BACKGROUNDS,
    MIN_CONTRAST,
    RESERVED_PATHS,
    normalizeUsername,
    isValidUsername,
    escapeRegExp,
    buildMatcher,
    looksLikeUrl,
    usernameFromUrl,
    isRepoRootPath,
    usernameFromHovercardUrl,
    normalizeHost,
    hostPattern,
    customHosts,
    badgeText,
    parseHex,
    toHex,
    normalizeHex,
    rgbToHsl,
    hslToRgb,
    contrastRatio,
    coerceColor,
    coerceSettings,
    packSettings,
    unpackSettings,
    describeSaveError,
    parseImport,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
