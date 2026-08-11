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
    /** {base, theme} once the user picks a color, null while on the default. */
    color: null,
  };

  /** The shipped pair: neon green on the dark theme, a deep green on the light one. */
  const DEFAULT_COLORS = { dark: '#39ff14', light: '#00891c' };

  /** What each variant has to stay readable against — GitHub's page background. */
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

  /** Lightness increments tried when re-lighting a color; 1/200 is finer than 8-bit. */
  const FIT_STEPS = 200;

  /**
   * How hard to push a derived variant, per theme.
   *
   * The two are deliberately not symmetric, because the headroom isn't. Almost
   * anything clears AA against GitHub's near-black canvas, so aiming at the
   * floor there produces a variant barely brighter than the color picked — the
   * shipped neon sits at 13.96:1, and a derived green landing at 4.6:1 would
   * look washed out beside it. Against white there is much less room, and the
   * hand-picked light default sits at 4.57:1, so the floor is the right aim.
   *
   * `stopLightness` is what keeps the higher dark-theme target from bleaching
   * the hues that would need a near-white lightness to reach it: red and purple
   * turn pink and lavender well before green does. Past that point the search
   * settles for whatever it has, as long as it is still readable.
   */
  const THEME_FIT = {
    dark: { target: 7, stopLightness: 0.72 },
    light: { target: MIN_CONTRAST, stopLightness: 0 },
  };

  /**
   * Re-light a color until it reads clearly against `background`.
   *
   * Hue and saturation are held fixed and only lightness moves, so the result
   * still reads as the same color rather than a different one. The search walks
   * away from the backdrop — brighter on a dark background, darker on a light
   * one — and stops as early as it can, which keeps the result as close to the
   * original as readability allows.
   */
  function fitToBackground(hex, background, { target = MIN_CONTRAST, stopLightness = null } = {}) {
    const rgb = parseHex(hex);
    const bg = parseHex(background);
    if (!rgb || !bg) return normalizeHex(hex) || DEFAULT_COLORS.dark;

    const hsl = rgbToHsl(rgb);
    const direction = relativeLuminance(bg) < 0.5 ? 1 : -1;
    const passedStop = (l) =>
      stopLightness !== null && (direction > 0 ? l >= stopLightness : l <= stopLightness);

    for (let step = 0; step <= FIT_STEPS; step += 1) {
      const l = Math.min(1, Math.max(0, hsl.l + (direction * step) / FIT_STEPS));
      const candidate = toHex(hslToRgb({ h: hsl.h, s: hsl.s, l }));
      const ratio = contrastRatio(candidate, background);

      if (ratio >= target) return candidate;
      // Readability is the hard requirement; the target is only an ambition, so
      // give it up rather than push the color past the point of washing out.
      if (ratio >= MIN_CONTRAST && passedStop(l)) return candidate;
    }

    // Unreachable in practice: white clears 4.5:1 on any background dark enough
    // to search upward from, and black clears it on any light one.
    return direction > 0 ? '#ffffff' : '#000000';
  }

  /**
   * Expand a single picked color into the pair the stylesheet needs.
   *
   * The pick is taken at face value for the theme it was made in — it is a
   * deliberate choice, and the user is looking straight at the result. Only the
   * other variant is computed, which is what stops a color chosen on the dark
   * theme from disappearing against white.
   *
   * @param {string} hex
   * @param {'dark'|'light'} theme the theme the pick was made in.
   * @returns {{dark: string, light: string}}
   */
  function deriveThemeColors(hex, theme) {
    const base = normalizeHex(hex);
    if (!base) return { ...DEFAULT_COLORS };

    const picked = theme === 'light' ? 'light' : 'dark';
    const derived = picked === 'light' ? 'dark' : 'light';

    return {
      [picked]: base,
      [derived]: fitToBackground(base, THEME_BACKGROUNDS[derived], THEME_FIT[derived]),
    };
  }

  /**
   * Stored form is the pick plus the theme it was made in, never the derived
   * pair — so a later change to the derivation reaches colors already saved.
   *
   * @returns {{base: string, theme: 'dark'|'light'}|null} null means "default".
   */
  function coerceColor(value) {
    if (!value || typeof value !== 'object') return null;

    const base = normalizeHex(value.base);
    if (!base) return null;

    return { base, theme: value.theme === 'light' ? 'light' : 'dark' };
  }

  /** @returns {{dark: string, light: string}} the pair to hand to CSS. */
  function resolveColors(color) {
    return color ? deriveThemeColors(color.base, color.theme) : { ...DEFAULT_COLORS };
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

  /**
   * Read an exported file back into a mappings object.
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

    return {
      mappings,
      skipped,
      enabled: typeof data.enabled === 'boolean' ? data.enabled : undefined,
      color: coerceColor(data.color),
    };
  }

  root.GHUN = {
    STORAGE_KEY,
    DEFAULT_SETTINGS,
    DEFAULT_COLORS,
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
    parseHex,
    toHex,
    normalizeHex,
    rgbToHsl,
    hslToRgb,
    contrastRatio,
    fitToBackground,
    deriveThemeColors,
    coerceColor,
    resolveColors,
    coerceSettings,
    parseImport,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
