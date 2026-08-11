/**
 * Rewrites mapped GitHub usernames in visible text.
 *
 * Every replacement is wrapped in a marked span holding the exact original
 * text, which gives us three things at once: the neon styling hook, the
 * hover tooltip, and a lossless undo when settings change.
 */
(function () {
  'use strict';

  const {
    STORAGE_KEY,
    DEFAULT_SETTINGS,
    buildMatcher,
    looksLikeUrl,
    isRepoRootPath,
    coerceSettings,
  } = globalThis.GHUN;

  const CLASS = 'ghun-name';
  const USER_ATTR = 'data-ghun-user';
  const RAW_ATTR = 'data-ghun-raw';

  /**
   * Subtrees we never rewrite.
   *
   * TEXTAREA/INPUT/SELECT matter most: GitHub's comment box is a real textarea,
   * and rewriting its contents would change what actually gets submitted.
   * CODE/PRE are excluded because a username there is usually part of a command
   * or path, where a silent rewrite would hand you a broken copy-paste.
   */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'SVG', 'MATH', 'IFRAME', 'OBJECT', 'CANVAS', 'VIDEO', 'AUDIO',
  ]);

  /**
   * Code that isn't marked up as code.
   *
   * GitHub's file and blame views render every source line as a plain `div`, so
   * the tag list above never fires there and a username sitting in source got
   * rewritten — exactly the broken copy-paste CODE/PRE exists to prevent. Diff
   * views are already safe: they use a real `code.diff-text` per line.
   *
   * These are GitHub's own unhashed class names, which is what makes them worth
   * matching on; the `*-module__*` classes around them are build hashes and
   * change without notice.
   */
  const SKIP_SELECTOR = [
    '.react-code-file-contents', // file view: the whole code body, pruned in one hit
    '.react-code-text', // file + blame view: one line's contents
    '.react-file-line', // file + blame view: the line itself
    '[data-testid="code-cell"]', // the same line, by the hook GitHub tests against
  ].join(',');

  /** Above this many queued roots it's cheaper to rescan the document once. */
  const FULL_RESCAN_THRESHOLD = 60;

  let settings = { ...DEFAULT_SETTINGS };
  let matcher = null;
  let observer = null;

  const queuedRoots = new Set();
  let flushScheduled = false;

  // --- element filtering -----------------------------------------------------

  /**
   * Checked without relying on `isContentEditable` alone, so the guard still
   * holds where that property is unimplemented or the editor is a custom one.
   */
  function isEditable(el) {
    if (el.isContentEditable) return true;
    const attr = el.getAttribute('contenteditable');
    if (attr !== null && attr !== 'false') return true;
    return el.getAttribute('role') === 'textbox';
  }

  /**
   * A link to a repo's home page shows a repo slug, not a person. Skipping it
   * keeps a repo named after its owner readable as itself.
   */
  function isRepoLink(el) {
    return el.tagName === 'A' && isRepoRootPath(el.getAttribute('href') || '');
  }

  /**
   * A link to the same person's account somewhere else — the website, X,
   * LinkedIn, Bluesky and Instagram rows in a profile's sidebar.
   *
   * What those rows show is that service's handle, and a handle is an
   * identifier on a site this extension knows nothing about: `@ObieMunoz`
   * under the X icon names an X account, and reading it as a person's name
   * makes the row disagree with where it points.
   *
   * `rel="me"` is the marker because GitHub puts it on every one of those rows
   * and nowhere else — it is the standard "another profile of mine" token, not
   * one of their class names, and markdown can't set it, so a link in someone's
   * profile README can't claim it.
   */
  function isAccountLink(el) {
    if (el.tagName !== 'A') return false;
    return (el.getAttribute('rel') || '').split(/\s+/).includes('me');
  }

  function isSkippableElement(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.matches(SKIP_SELECTOR)) return true;
    if (isEditable(el)) return true;
    if (isRepoLink(el)) return true;
    if (isAccountLink(el)) return true;
    // Our own output — the guard that stops the observer looping on itself.
    if (el.hasAttribute(USER_ATTR)) return true;
    // Our own injected UI, which must keep showing raw usernames.
    if (el.hasAttribute('data-ghun-ui')) return true;
    return false;
  }

  /**
   * The TreeWalker filter never runs on the root itself, and mutation roots can
   * land anywhere, so ancestors get checked separately before a scan starts.
   */
  function hasSkippedAncestor(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el) {
      if (isSkippableElement(el)) return true;
      el = el.parentElement;
    }
    return false;
  }

  // --- replacement -----------------------------------------------------------

  function buildReplacement(rawMatch, atSign, username) {
    const replacement = settings.mappings[username.toLowerCase()];
    if (!replacement) return null;

    const span = document.createElement('span');
    span.className = CLASS;
    span.setAttribute(USER_ATTR, username);
    span.setAttribute(RAW_ATTR, rawMatch);
    span.title = rawMatch;
    span.textContent = atSign + replacement;
    return span;
  }

  /** @returns {boolean} whether the node was rewritten. */
  function replaceInTextNode(node) {
    const text = node.nodeValue;
    if (!text || text.length < 2) return false;

    matcher.lastIndex = 0;
    if (!matcher.test(text)) return false;
    if (looksLikeUrl(text)) return false;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let match;

    matcher.lastIndex = 0;
    while ((match = matcher.exec(text)) !== null) {
      const [rawMatch, atSign, username] = match;
      const span = buildReplacement(rawMatch, atSign, username);
      if (!span) continue;

      if (match.index > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, match.index)));
      }
      fragment.appendChild(span);
      cursor = match.index + rawMatch.length;
    }

    if (cursor === 0) return false;
    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)));
    }

    node.parentNode.replaceChild(fragment, node);
    return true;
  }

  function scan(root) {
    if (!matcher || !settings.enabled || !root || !root.isConnected) return;
    if (hasSkippedAncestor(root)) return;

    if (root.nodeType === Node.TEXT_NODE) {
      replaceInTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;

    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // REJECT prunes the whole subtree; SKIP keeps descending.
            return isSkippableElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );

    // Collect first: replacing nodes mid-walk invalidates the walker.
    const targets = [];
    let node;
    while ((node = walker.nextNode()) !== null) targets.push(node);
    for (const target of targets) {
      if (target.isConnected) replaceInTextNode(target);
    }
  }

  /** Put every replaced span back to its original text. */
  function restoreAll(root) {
    const scope = root || document.body;
    if (!scope) return;

    const spans = scope.querySelectorAll(`span.${CLASS}[${RAW_ATTR}]`);
    for (const span of spans) {
      const original = document.createTextNode(span.getAttribute(RAW_ATTR));
      span.parentNode.replaceChild(original, span);
    }
    // Re-merge the split text nodes so a later scan sees whole strings again.
    if (spans.length) scope.normalize();
  }

  // --- mutation handling -----------------------------------------------------

  function flush() {
    flushScheduled = false;
    const roots = Array.from(queuedRoots);
    queuedRoots.clear();

    if (!matcher || !settings.enabled) return;

    if (roots.length > FULL_RESCAN_THRESHOLD) {
      scan(document.body);
      return;
    }
    for (const root of roots) scan(root);
  }

  function queueRoot(node) {
    if (!node) return;
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE) return;
    queuedRoots.add(node);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flush, 0);
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (!settings.enabled || !matcher) return;
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const added of mutation.addedNodes) queueRoot(added);
        } else if (mutation.type === 'characterData') {
          queueRoot(mutation.target);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // --- settings --------------------------------------------------------------

  /**
   * Publish the chosen highlight color, which is used on both GitHub themes.
   *
   * Clearing it rather than writing a default back is what lets content.css keep
   * owning the shipped default: its own cascade still swaps neon for a readable
   * green on the light theme, and an inline value here simply outranks it.
   */
  function applyColor() {
    const root = document.documentElement;
    if (!root) return;

    if (settings.color) root.style.setProperty('--ghun-color', settings.color);
    else root.style.removeProperty('--ghun-color');
  }

  function applySettings(stored, { rescan = true } = {}) {
    settings = coerceSettings(stored);
    matcher = buildMatcher(settings.mappings);
    applyColor();
    if (!rescan) return;

    restoreAll();
    if (settings.enabled && matcher) scan(document.body);
  }

  /**
   * After the extension is reloaded or updated, the old content script keeps
   * running against a dead port. Detect that and stop cleanly.
   */
  function isContextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function shutdown() {
    if (observer) observer.disconnect();
    observer = null;
  }

  function start() {
    if (!isContextAlive()) return;

    chrome.storage.sync.get(STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) return;
      applySettings(result[STORAGE_KEY], { rescan: false });
      if (settings.enabled && matcher) scan(document.body);
      startObserver();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes[STORAGE_KEY]) return;
      if (!isContextAlive()) return shutdown();
      applySettings(changes[STORAGE_KEY].newValue);
    });

    // Turbo can swap the whole body at once; the observer catches that, but a
    // direct hook costs nothing and closes any gap on soft navigation.
    document.addEventListener('turbo:load', () => scan(document.body));
    document.addEventListener('turbo:frame-load', (event) => scan(event.target));
  }

  // Exposed for hovercard.js, the test suite, and the offline demo page.
  globalThis.GHUN_ENGINE = {
    scan,
    restoreAll,
    applySettings,
    start,
    shutdown,
    getSettings: () => settings,
  };

  if (typeof chrome !== 'undefined' && chrome.storage) start();
})();
