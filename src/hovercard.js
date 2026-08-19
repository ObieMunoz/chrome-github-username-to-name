/**
 * Adds a "Show as a real name…" row to GitHub's profile hovercard, so a
 * username can be mapped from wherever it appears without leaving the page.
 *
 * GitHub currently runs two hovercard implementations side by side, and this
 * file has to serve both:
 *
 *  - The classic one: a single `.js-hovercard-content` container in the page
 *    layout, into which server-rendered card HTML is swapped. Triggers carry
 *    `data-hovercard-url`.
 *  - The React one, used on the rewritten surfaces (issues, pull requests,
 *    dashboard): the card is rendered as an overlay into the
 *    `#__primerPortalRoot__` portal or a native `[popover]` element, and the
 *    trigger is often a plain profile link with no `data-hovercard-url`.
 *
 * The classic path is matched exactly. The React path has no stable class
 * names (they are build-hashed), so it is matched by behaviour instead: an
 * overlay that appears right after a profile link was hovered, without a
 * click in between, and that links back to the hovered user, is that user's
 * hovercard. The gates below keep click-opened menus and dialogs out.
 *
 * The editor itself is a separate panel appended to <body>, deliberately not
 * placed inside the hovercard: GitHub removes the hovercard as soon as the
 * pointer leaves it, which would destroy an inline form mid-typing.
 */
(function () {
  'use strict';

  const {
    STORAGE_KEY,
    coerceSettings,
    usernameFromHovercardUrl,
    usernameFromUrl,
    normalizeUsername,
  } = globalThis.GHUN;

  const HOVERCARD_SELECTOR = '.js-hovercard-content';
  const PORTAL_ID = '__primerPortalRoot__';
  const ROW_CLASS = 'ghun-card-row';
  const OVERLAY_ROW_CLASS = 'ghun-card-overlay';
  const PANEL_ID = 'ghun-panel';

  /**
   * How long after a hover an appearing overlay can still be read as that
   * hover's card. GitHub fetches card content lazily, so this needs slack,
   * but it must not be unbounded or any later overlay would qualify.
   */
  const HOVER_FRESH_MS = 10000;

  /**
   * Real form fields mark an overlay as a menu or dialog, never a hovercard.
   * Hidden inputs stay allowed: the card's own Follow form uses them.
   */
  const FORM_FIELD_SELECTOR =
    'textarea, select, input:not([type="hidden"]):not([type="submit"])';

  /**
   * The last hover that could open a hovercard: who it was about and when.
   *
   * `data-hovercard-url` on the trigger is authoritative when present — it is
   * GitHub's own annotation, and an organization's `/orgs/…` URL deliberately
   * resolves to a null username so an org card is never enhanced. Profile
   * links without the annotation (the React surfaces) fall back to the link
   * target itself. Reassigned on every annotated hover, including to null, so
   * an organization hovercard can't inherit the previous user.
   */
  let hovered = null;
  let pointerDownAt = 0;
  let panel = null;

  // --- tracking which user the hovercard is about ----------------------------

  document.addEventListener(
    'mouseover',
    (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      const annotated = target.closest('[data-hovercard-url]');
      if (annotated) {
        hovered = {
          username: usernameFromHovercardUrl(annotated.getAttribute('data-hovercard-url')),
          at: Date.now(),
        };
        return;
      }

      const link = target.closest('a[href]');
      if (!link || link.closest('[data-ghun-ui]')) return;

      const username = usernameFromUrl(link.getAttribute('href'));
      // A non-profile link doesn't clear the state: the pointer crosses
      // plenty of other links on its way to a card that is still loading.
      if (username) hovered = { username, at: Date.now() };
    },
    true
  );

  // Overlays opened by a click — menus, dialogs — are never hovercards.
  document.addEventListener(
    'mousedown',
    () => {
      pointerDownAt = Date.now();
    },
    true
  );

  function currentName(username) {
    const engine = globalThis.GHUN_ENGINE;
    const settings = engine && engine.getSettings ? engine.getSettings() : null;
    if (!settings || !settings.mappings) return '';
    return settings.mappings[normalizeUsername(username)] || '';
  }

  // --- storage ---------------------------------------------------------------

  /**
   * Re-read before writing so a change made in the popup meanwhile isn't lost.
   * Saving triggers storage.onChanged, which makes the engine repaint the page.
   */
  async function persist(username, name) {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    const settings = coerceSettings(stored[STORAGE_KEY]);
    const key = normalizeUsername(username);

    if (name) settings.mappings[key] = name;
    else delete settings.mappings[key];

    await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
  }

  // --- the editor panel ------------------------------------------------------

  function closePanel() {
    if (panel) {
      panel.remove();
      panel = null;
    }
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('mousedown', onOutsideClick, true);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePanel();
    }
  }

  function onOutsideClick(event) {
    if (panel && !panel.contains(event.target)) closePanel();
  }

  /**
   * Structural layout is set inline rather than in content.css on purpose. If
   * the stylesheet is stale or fails to load, a CSS-positioned panel drops into
   * normal flow at the very bottom of the page; inline styles keep it anchored
   * and on top no matter what.
   */
  function applyStructuralStyles() {
    panel.style.position = 'fixed';
    panel.style.zIndex = '2147483647';
    panel.style.width = '260px';
    panel.style.boxSizing = 'border-box';
  }

  function position(anchorRect) {
    const rect = panel.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - rect.width - 8);

    let top = anchorRect.bottom + 6;
    if (top + rect.height > window.innerHeight - 8) {
      top = Math.max(8, anchorRect.top - rect.height - 6);
    }

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function openPanel(username, anchorRect) {
    closePanel();

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.setAttribute('data-ghun-ui', '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `Replacement name for ${username}`);

    const title = document.createElement('div');
    title.className = 'ghun-panel-title';
    title.textContent = username;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ghun-panel-input';
    input.placeholder = 'Real name';
    input.value = currentName(username);
    input.spellcheck = false;
    input.setAttribute('aria-label', `Show ${username} as`);

    const actions = document.createElement('div');
    actions.className = 'ghun-panel-actions';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'ghun-panel-save';
    save.textContent = 'Save';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghun-panel-remove';
    remove.textContent = 'Remove';
    remove.hidden = !currentName(username);

    async function commit(name) {
      closePanel();
      await persist(username, name);
      // The hovercard may still be open behind the panel; relabel it directly
      // rather than waiting on the storage change to propagate.
      refreshRows(username, name);
    }

    save.addEventListener('click', () => commit(input.value.trim()));
    remove.addEventListener('click', () => commit(''));
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      commit(input.value.trim());
    });

    actions.append(save, remove);
    panel.append(title, input, actions);

    // Measure before showing so the panel can't flash in the wrong spot.
    applyStructuralStyles();
    panel.style.visibility = 'hidden';
    document.body.appendChild(panel);
    position(anchorRect);
    panel.style.visibility = '';

    input.focus();
    input.select();

    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('mousedown', onOutsideClick, true);
  }

  // --- the hovercard row -----------------------------------------------------

  function rowLabel(name) {
    return name ? `Showing as “${name}”` : 'Show as a real name…';
  }

  /** Relabel any open hovercard row for this user. */
  function refreshRows(username, name) {
    for (const row of document.querySelectorAll(`.${ROW_CLASS}`)) {
      if (row.dataset.ghunFor !== username) continue;
      const button = row.querySelector('.ghun-card-button');
      if (button) button.textContent = rowLabel(name);
    }
  }

  function buildRow(username, { overlay = false } = {}) {
    const row = document.createElement('div');
    row.className = overlay ? `${ROW_CLASS} ${OVERLAY_ROW_CLASS}` : ROW_CLASS;
    row.setAttribute('data-ghun-ui', '');
    row.dataset.ghunFor = username;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghun-card-button';

    button.textContent = rowLabel(currentName(username));

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPanel(username, button.getBoundingClientRect());
    });

    row.appendChild(button);
    return row;
  }

  function placeRow(container, username, options) {
    const existing = container.querySelector(`.${ROW_CLASS}`);
    if (existing) {
      // The container gets reused across users; replace a stale row.
      if (existing.dataset.ghunFor === username) return;
      existing.remove();
    }
    container.appendChild(buildRow(username, options));
  }

  /** The classic path: GitHub swapped card HTML into `.js-hovercard-content`. */
  function enhance(card) {
    if (!hovered || !hovered.username) return;

    const message = card.querySelector('.Popover-message') || card;
    placeRow(message, hovered.username, { overlay: false });
  }

  /** True when the overlay links back to the hovered user's profile. */
  function linksToProfile(overlay, username) {
    const key = normalizeUsername(username);
    for (const link of overlay.querySelectorAll('a[href]')) {
      const candidate = usernameFromUrl(link.getAttribute('href'));
      if (candidate && normalizeUsername(candidate) === key) return true;
    }
    return false;
  }

  /**
   * The React path: an overlay with no stable markup, identified by behaviour.
   *
   * Every gate here exists to keep this from firing on something that merely
   * appeared near a hover: the overlay must follow the hover promptly, with no
   * click in between (menus and dialogs open on click, hovercards never do),
   * must not be a form (ditto), and must link back to the hovered user.
   */
  function enhanceOverlay(overlay) {
    if (!hovered || !hovered.username) return;
    if (Date.now() - hovered.at > HOVER_FRESH_MS) return;
    // At-or-after: a press in the same millisecond as the hover is still a
    // press, and a real hovercard needs longer than that to appear anyway.
    if (pointerDownAt >= hovered.at && pointerDownAt !== 0) return;
    if (!overlay.isConnected) return;
    if (overlay.closest('[data-ghun-ui]')) return;
    // The classic container is handled by `enhance` with exact selectors.
    if (overlay.closest(HOVERCARD_SELECTOR)) return;
    if (overlay.querySelector(FORM_FIELD_SELECTOR)) return;
    if (!linksToProfile(overlay, hovered.username)) return;

    placeRow(overlay, hovered.username, { overlay: true });
  }

  /**
   * The overlay root for a node rendered into the Primer React portal: the
   * portal's direct child the node sits under, which is the element that
   * frames the card on screen.
   */
  function portalRootFor(node) {
    const portal = document.getElementById(PORTAL_ID);
    if (!portal || node === portal || !portal.contains(node)) return null;

    let root = node;
    while (root.parentElement && root.parentElement !== portal) root = root.parentElement;
    return root.parentElement === portal ? root : null;
  }

  function inspectAddedNode(node) {
    // Classic: the card itself appeared, content was swapped into an existing
    // card (the card is then an ancestor), or a subtree brought cards along.
    const card = node.matches(HOVERCARD_SELECTOR) ? node : node.closest(HOVERCARD_SELECTOR);
    if (card) {
      enhance(card);
      return;
    }
    for (const inner of node.querySelectorAll(HOVERCARD_SELECTOR)) enhance(inner);

    // React: content lands inside the portal in stages — the overlay shell
    // first, the fetched card after — so the same root is re-checked on every
    // addition and enhanced once its profile link exists.
    const portalRoot = portalRootFor(node);
    if (portalRoot) {
      enhanceOverlay(portalRoot);
      return;
    }

    // React, native popover API variant.
    const popover = node.matches('[popover]') ? node : node.closest('[popover]');
    if (popover) {
      enhanceOverlay(popover);
      return;
    }
    for (const inner of node.querySelectorAll('[popover]')) enhanceOverlay(inner);
  }

  function watchForHovercards() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          inspectAddedNode(node);
        }
      }
    });

    // The document element, not the body: GitHub's soft navigation can swap
    // the whole <body>, and an observer attached to the old one dies with it.
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (typeof chrome !== 'undefined' && chrome.storage) watchForHovercards();

  globalThis.GHUN_HOVERCARD = { enhance, enhanceOverlay, openPanel, watchForHovercards };
})();
