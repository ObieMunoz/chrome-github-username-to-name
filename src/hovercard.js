/**
 * Adds a "Show as a real name…" row to GitHub's own profile hovercard, so a
 * username can be mapped from wherever it appears without leaving the page.
 *
 * The editor itself is a separate panel appended to <body>, deliberately not
 * placed inside the hovercard: GitHub removes the hovercard as soon as the
 * pointer leaves it, which would destroy an inline form mid-typing.
 */
(function () {
  'use strict';

  const { STORAGE_KEY, coerceSettings, usernameFromHovercardUrl, normalizeUsername } =
    globalThis.GHUN;

  const HOVERCARD_SELECTOR = '.js-hovercard-content';
  const ROW_CLASS = 'ghun-card-row';
  const PANEL_ID = 'ghun-panel';

  /**
   * Set from GitHub's own annotation on the trigger element, which is far more
   * reliable than reading the popup's markup. Always reassigned (including to
   * null) so an organization hovercard can't inherit the previous user.
   */
  let hoveredUsername = null;
  let panel = null;

  // --- tracking which user the hovercard is about ----------------------------

  document.addEventListener(
    'mouseover',
    (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      const trigger = target.closest('[data-hovercard-url]');
      if (!trigger) return;

      hoveredUsername = usernameFromHovercardUrl(trigger.getAttribute('data-hovercard-url'));
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

  function buildRow(username) {
    const row = document.createElement('div');
    row.className = ROW_CLASS;
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

  function enhance(card) {
    if (!hoveredUsername) return;

    const message = card.querySelector('.Popover-message') || card;
    const existing = message.querySelector(`.${ROW_CLASS}`);

    if (existing) {
      // The container gets reused across users; replace a stale row.
      if (existing.dataset.ghunFor === hoveredUsername) return;
      existing.remove();
    }

    message.appendChild(buildRow(hoveredUsername));
  }

  function watchForHovercards() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          // Either the card itself appeared, or content was swapped into an
          // existing card, in which case the card is an ancestor.
          if (node.matches && node.matches(HOVERCARD_SELECTOR)) enhance(node);

          const parentCard = node.closest && node.closest(HOVERCARD_SELECTOR);
          if (parentCard) enhance(parentCard);

          if (node.querySelectorAll) {
            for (const card of node.querySelectorAll(HOVERCARD_SELECTOR)) enhance(card);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (typeof chrome !== 'undefined' && chrome.storage) watchForHovercards();

  globalThis.GHUN_HOVERCARD = { enhance, openPanel, watchForHovercards };
})();
