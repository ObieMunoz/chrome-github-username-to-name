/**
 * Popup UI: manage the username -> real name mappings.
 *
 * All rendering goes through textContent, never innerHTML, so a replacement
 * containing markup can't inject anything into this page.
 */
(function () {
  'use strict';

  const {
    DEFAULT_COLOR,
    THEME_BACKGROUNDS,
    MIN_CONTRAST,
    normalizeUsername,
    isValidUsername,
    describeSaveError,
    parseImport,
    parseHex,
    toHex,
    rgbToHsl,
    hslToRgb,
    contrastRatio,
  } = globalThis.GHUN;
  const store = globalThis.GHUN_STORE;

  const el = {
    enabled: document.getElementById('enabled'),
    summary: document.getElementById('summary'),
    form: document.getElementById('add-form'),
    username: document.getElementById('username'),
    replacement: document.getElementById('replacement'),
    status: document.getElementById('status'),
    listHeader: document.getElementById('list-header'),
    filter: document.getElementById('filter'),
    list: document.getElementById('list'),
    empty: document.getElementById('empty'),
    swatch: document.getElementById('color-swatch'),
    colorValue: document.getElementById('color-value'),
    wheel: document.getElementById('wheel'),
    marker: document.getElementById('wheel-marker'),
    hex: document.getElementById('hex'),
    swatches: [document.getElementById('chip-dark'), document.getElementById('chip-light')],
    note: document.getElementById('color-note'),
    colorReset: document.getElementById('color-reset'),
    exportJson: document.getElementById('export-json'),
    copyBtn: document.getElementById('copy'),
    importJson: document.getElementById('import-json'),
    importBtn: document.getElementById('import'),
  };

  let settings = { enabled: true, mappings: {}, color: null };
  let statusTimer = null;

  // --- storage ---------------------------------------------------------------

  function load() {
    return store.load(chrome.storage.sync);
  }

  async function save() {
    try {
      await store.save(chrome.storage.sync, settings);
    } catch (error) {
      showStatus(describeSaveError(error), true);
      return false;
    }
    // The export box shows what is stored, so it is refreshed where the
    // store is written — every path that changes a setting ends up here.
    renderExport();
    return true;
  }

  // --- views -----------------------------------------------------------------

  /**
   * One view at a time.
   *
   * A Chrome popup is capped at 600px tall, and the list, the color wheel and
   * the backup boxes come to well over that together — unfolded in place, most
   * of a panel sat below the fold with only an overlay scrollbar, invisible at
   * rest, to say so. Swapping views instead keeps every one of them inside the
   * cap on its own, so there is never anything off the bottom to discover.
   */
  const views = {
    main: document.getElementById('view-main'),
    color: document.getElementById('view-color'),
    backup: document.getElementById('view-backup'),
  };

  /** The row a panel was opened from, so Back can hand focus straight back. */
  let openedFrom = null;

  function showView(name) {
    for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
    // Views are separate pages as far as the reader is concerned, so none of
    // them should open part way down. The popup only has a scroll position to
    // inherit when it is zoomed past the point where 600px still fits, but that
    // is exactly when opening mid-panel would be worst.
    window.scrollTo(0, 0);
  }

  function openPanel(name, from) {
    openedFrom = from;
    showView(name);
    // The way out, rather than the first control: a panel opened by keyboard
    // otherwise leaves focus on a row that is no longer on the page.
    views[name].querySelector('.back').focus();
  }

  function closePanel() {
    showView('main');
    if (openedFrom) openedFrom.focus();
    openedFrom = null;
  }

  function wireViews() {
    for (const row of document.querySelectorAll('.nav-row')) {
      row.addEventListener('click', () => openPanel(row.dataset.open, row));
    }
    for (const back of document.querySelectorAll('.back')) {
      back.addEventListener('click', closePanel);
    }

    // Escape reads as "back" once there is somewhere to go back to. Whether the
    // browser lets the popup keep the key is up to the browser; where it does
    // not, this falls back to the popup closing, which is what Escape did here
    // before either way.
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !views.main.hidden) return;
      event.preventDefault();
      closePanel();
    });
  }

  // --- rendering -------------------------------------------------------------

  function showStatus(message, isError = false) {
    clearTimeout(statusTimer);
    el.status.textContent = message;
    el.status.classList.toggle('error', isError);
    el.status.hidden = false;
    statusTimer = setTimeout(() => {
      el.status.hidden = true;
    }, isError ? 6000 : 2500);
  }

  function sortedEntries() {
    return Object.entries(settings.mappings).sort((a, b) =>
      a[1].localeCompare(b[1], undefined, { sensitivity: 'base' })
    );
  }

  function buildRow(username, replacement) {
    const row = document.createElement('li');
    row.className = 'row';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = username;
    name.title = username;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = replacement;
    input.setAttribute('aria-label', `Replacement for ${username}`);
    input.addEventListener('change', async () => {
      const value = input.value.trim();
      if (!value) {
        input.value = settings.mappings[username];
        showStatus('Replacement cannot be empty.', true);
        return;
      }
      settings.mappings[username] = value;
      if (await save()) showStatus(`Updated ${username}.`);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete';
    remove.textContent = '✕';
    remove.title = `Remove ${username}`;
    remove.setAttribute('aria-label', `Remove ${username}`);
    remove.addEventListener('click', async () => {
      delete settings.mappings[username];
      if (await save()) {
        render();
        showStatus(`Removed ${username}.`);
      }
    });

    row.append(name, input, remove);
    return row;
  }

  function render() {
    const entries = sortedEntries();
    const query = el.filter.value.trim().toLowerCase();
    const visible = query
      ? entries.filter(
          ([username, replacement]) =>
            username.includes(query) || replacement.toLowerCase().includes(query)
        )
      : entries;

    el.list.textContent = '';
    for (const [username, replacement] of visible) {
      el.list.appendChild(buildRow(username, replacement));
    }

    const count = entries.length;
    el.summary.textContent =
      count === 0 ? 'No names yet' : `${count} name${count === 1 ? '' : 's'} replaced`;
    el.listHeader.hidden = count < 6;
    el.empty.hidden = count > 0;
    el.enabled.checked = settings.enabled;

    // The previews sample a real mapping, so they follow the list.
    renderColor();
  }

  // --- color picker ----------------------------------------------------------

  /** CSS pixel size of the wheel; the canvas itself is scaled for the display. */
  const WHEEL_SIZE = 124;

  /**
   * Lightness the wheel is painted at, and the one a click on it produces.
   *
   * Fixing the two to the same value is what makes the wheel honest: the pixel
   * under the cursor is exactly the color that gets stored. 0.5 is where hues
   * are at their most saturated, so the wheel also reads clearly as a wheel.
   * A specific shade outside that band is what the hex field is for, and typing
   * one repaints the wheel at that lightness so the two never disagree.
   */
  const WHEEL_LIGHTNESS = 0.5;

  /** GitHub's own muted and danger foregrounds, one pair per preview backdrop. */
  const SWATCH_TEXT = {
    dark: { muted: '#8b949e', danger: '#f85149' },
    light: { muted: '#57606a', danger: '#cf222e' },
  };

  /** Stand-in shown in the previews. Deliberately not one of the saved names. */
  const SAMPLE_NAME = 'Real Name';

  /**
   * The live pick, kept in HSL rather than as a hex string: the wheel maps angle
   * to hue and radius to saturation, and round-tripping through hex would lose
   * both whenever the color passes through black, white or grey.
   */
  let picker = { h: 0, s: 0, l: WHEEL_LIGHTNESS };

  /** Lightness the wheel was last painted at, so it only repaints when it must. */
  let paintedLightness = null;
  let colorSaveTimer = null;

  function currentHex() {
    return toHex(hslToRgb(picker));
  }

  function setPicker(hex) {
    const rgb = parseHex(hex);
    if (!rgb) return;

    const hsl = rgbToHsl(rgb);
    // A grey reports hue 0; keeping the old one leaves the wheel where it was
    // instead of snapping the marker onto the red axis.
    picker = { h: hsl.s === 0 ? picker.h : hsl.h, s: hsl.s, l: hsl.l };
  }

  /** Start from the stored pick, or from the default the wheel opens on. */
  function initPicker() {
    setPicker(settings.color || DEFAULT_COLOR);
  }

  function sizeWheel() {
    const scale = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    el.wheel.width = WHEEL_SIZE * scale;
    el.wheel.height = WHEEL_SIZE * scale;
    el.wheel.style.width = `${WHEEL_SIZE}px`;
    el.wheel.style.height = `${WHEEL_SIZE}px`;
  }

  /**
   * Paint the wheel one pixel at a time in the same HSL the rest of the color
   * maths uses, so the hue and saturation under the cursor are exactly the ones
   * picked — a CSS gradient approximation would drift from them.
   *
   * Painted once, since nothing about it changes as you pick.
   */
  function drawWheel() {
    const context = el.wheel.getContext('2d');
    const size = el.wheel.width;
    const radius = size / 2;
    const image = context.createImageData(size, size);
    const { data } = image;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x - radius + 0.5;
        const dy = y - radius + 0.5;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > radius) continue; // Leaves this pixel transparent.

        const { r, g, b } = hslToRgb({
          // Negative y because canvas counts downward and hue runs anticlockwise.
          h: (Math.atan2(-dy, dx) * 180) / Math.PI,
          s: Math.min(1, distance / radius),
          l: WHEEL_LIGHTNESS,
        });

        const index = (y * size + x) * 4;
        data[index] = r;
        data[index + 1] = g;
        data[index + 2] = b;
        // Feather the outer ring so the edge doesn't look sawn off.
        data[index + 3] = Math.round(255 * Math.min(1, radius - distance));
      }
    }

    context.putImageData(image, 0, 0);
  }

  function positionMarker() {
    const radius = WHEEL_SIZE / 2;
    const angle = (picker.h * Math.PI) / 180;
    el.marker.style.left = `${radius + Math.cos(angle) * picker.s * radius}px`;
    el.marker.style.top = `${radius - Math.sin(angle) * picker.s * radius}px`;
    el.marker.style.background = currentHex();
  }

  /**
   * Preview the chosen color on one of GitHub's two backgrounds.
   *
   * Both are shown because the same color is used on both themes, so which one
   * you get depends on how GitHub is set at the time. The ratio turns red below
   * the readability floor — that is information, not a veto; the color is
   * whatever was asked for.
   */
  function renderSwatch(swatch) {
    const theme = swatch.dataset.theme;
    const color = currentHex();
    const ratio = contrastRatio(color, THEME_BACKGROUNDS[theme]);

    swatch.style.background = THEME_BACKGROUNDS[theme];
    swatch.title = `${color} on GitHub's ${theme} theme — ${ratio.toFixed(2)}:1`;

    const sample = swatch.querySelector('.chip-sample');
    sample.textContent = SAMPLE_NAME;
    sample.style.color = color;

    const meta = swatch.querySelector('.chip-meta');
    meta.textContent = `${ratio.toFixed(1)}:1`;
    meta.style.color = SWATCH_TEXT[theme][ratio < MIN_CONTRAST ? 'danger' : 'muted'];
  }

  function renderColor() {
    const color = currentHex();

    if (picker.l !== paintedLightness) drawWheel();
    positionMarker();

    // Leave the field alone mid-typing, or the caret jumps on every keystroke.
    if (document.activeElement !== el.hex) el.hex.value = color;

    for (const swatch of el.swatches) renderSwatch(swatch);

    el.note.textContent =
      'Used on both GitHub themes. The two swatches show it on each.';

    document.documentElement.style.setProperty('--neon', color);
    // The row into the panel carries the pick, so the list still answers "what
    // color is it?" without a trip inside.
    el.swatch.style.background = color;
    el.colorValue.textContent = color;
    el.colorReset.hidden = !settings.color;
  }

  /**
   * Dragging fires a lot of events and chrome.storage.sync caps writes per
   * minute, so only the write is debounced. The settings object is updated
   * straight away, which is what keeps the preview and the reset button
   * agreeing with the wheel between one write and the next.
   */
  function commitColor() {
    settings.color = currentHex();
    renderColor();

    clearTimeout(colorSaveTimer);
    // Failures surface through save()'s own status message.
    colorSaveTimer = setTimeout(save, 300);
  }

  function pickFromPointer(event) {
    const rect = el.wheel.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = event.clientX - rect.left - radius;
    const dy = event.clientY - rect.top - radius;

    picker.h = (((Math.atan2(-dy, dx) * 180) / Math.PI) + 360) % 360;
    picker.s = Math.min(1, Math.sqrt(dx * dx + dy * dy) / radius);
    // The wheel is painted at one lightness, so a click has to land on it too,
    // or the color stored would not be the pixel that was clicked.
    picker.l = WHEEL_LIGHTNESS;
    commitColor();
  }

  const WHEEL_KEYS = {
    ArrowLeft: { h: -4 },
    ArrowRight: { h: 4 },
    ArrowUp: { s: 0.04 },
    ArrowDown: { s: -0.04 },
  };

  async function resetColor() {
    clearTimeout(colorSaveTimer);
    settings.color = null;

    if (await save()) {
      initPicker();
      renderColor();
      showStatus('Highlight color reset.');
    }
  }

  function wireColorPicker() {
    sizeWheel();
    drawWheel();

    el.wheel.addEventListener('pointerdown', (event) => {
      pickFromPointer(event);
      try {
        // Only needed so a drag can leave the canvas; the pick above already
        // landed, so a refused capture must not take the click down with it.
        el.wheel.setPointerCapture(event.pointerId);
      } catch {
        /* no drag tracking, clicks still work */
      }
    });
    el.wheel.addEventListener('pointermove', (event) => {
      if (el.wheel.hasPointerCapture(event.pointerId)) pickFromPointer(event);
    });
    el.wheel.addEventListener('keydown', (event) => {
      const delta = WHEEL_KEYS[event.key];
      if (!delta) return;
      event.preventDefault();

      const scale = event.shiftKey ? 4 : 1;
      if (delta.h) picker.h = (picker.h + delta.h * scale + 360) % 360;
      if (delta.s) picker.s = Math.min(1, Math.max(0, picker.s + delta.s * scale));
      picker.l = WHEEL_LIGHTNESS;
      commitColor();
    });

    el.hex.addEventListener('input', () => {
      if (!parseHex(el.hex.value)) return;
      setPicker(el.hex.value);
      commitColor();
    });
    el.hex.addEventListener('blur', () => {
      el.hex.value = currentHex();
    });

    el.colorReset.addEventListener('click', resetColor);
  }

  // --- actions ---------------------------------------------------------------

  async function addMapping(event) {
    event.preventDefault();

    const username = normalizeUsername(el.username.value);
    const replacement = el.replacement.value.trim();

    if (!username || !isValidUsername(username)) {
      showStatus('That does not look like a GitHub username.', true);
      el.username.focus();
      return;
    }
    if (!replacement) {
      showStatus('Enter the name to show instead.', true);
      el.replacement.focus();
      return;
    }

    const existed = Object.prototype.hasOwnProperty.call(settings.mappings, username);
    settings.mappings[username] = replacement;

    if (await save()) {
      el.form.reset();
      render();
      el.username.focus();
      showStatus(existed ? `Updated ${username}.` : `${username} → ${replacement}`);
    }
  }

  async function toggleEnabled() {
    settings.enabled = el.enabled.checked;
    if (await save()) {
      showStatus(settings.enabled ? 'Replacements on.' : 'Replacements paused.');
    }
  }

  /** Everything worth keeping, in the shape `parseImport` reads back. */
  function renderExport() {
    // Leave it alone while it has focus, so a refresh can't drop a selection
    // someone is part way through copying by hand.
    if (document.activeElement === el.exportJson) return;

    el.exportJson.value = JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        enabled: settings.enabled,
        color: settings.color,
        mappings: settings.mappings,
      },
      null,
      2
    );
  }

  async function copyExport() {
    try {
      await navigator.clipboard.writeText(el.exportJson.value);
      showStatus('Copied to the clipboard.');
    } catch {
      // The clipboard can be refused. Selecting the text leaves the copy one
      // keystroke away rather than dead-ending.
      el.exportJson.focus();
      el.exportJson.select();
      showStatus('Could not reach the clipboard. The text is selected — press Ctrl/⌘ C.', true);
    }
  }

  /**
   * The pasted text a second Import click would overwrite entries for.
   *
   * Overwriting is the one destructive thing this popup does, so it takes two
   * clicks. Comparing the text rather than a flag means editing the paste asks
   * again, and a native confirm() is avoided: the dialog can take the popup —
   * and the pasted text with it — down.
   */
  let pendingImport = null;

  async function importMappings() {
    const text = el.importJson.value.trim();
    if (!text) {
      showStatus('Paste a backup into the box first.', true);
      el.importJson.focus();
      return;
    }

    let parsed;
    try {
      parsed = parseImport(text);
    } catch (error) {
      showStatus(error.message, true);
      return;
    }

    const incoming = Object.keys(parsed.mappings);
    const overwrites = incoming.filter((username) =>
      Object.prototype.hasOwnProperty.call(settings.mappings, username)
    );

    if (overwrites.length && pendingImport !== text) {
      pendingImport = text;
      showStatus(
        `${overwrites.length} of ${incoming.length} pasted names already exist. ` +
          'Import again to overwrite them.',
        true
      );
      return;
    }

    settings.mappings = { ...settings.mappings, ...parsed.mappings };
    if (typeof parsed.enabled === 'boolean') settings.enabled = parsed.enabled;
    if (parsed.color) settings.color = parsed.color;

    if (await save()) {
      pendingImport = null;
      el.importJson.value = '';
      initPicker();
      render();
      const skipped = parsed.skipped ? `, ${parsed.skipped} skipped` : '';
      showStatus(`Imported ${incoming.length} name${incoming.length === 1 ? '' : 's'}${skipped}.`);
    }
  }

  // --- wiring ----------------------------------------------------------------

  async function init() {
    settings = await load();
    initPicker();
    wireViews();
    wireColorPicker();
    render();
    renderExport();

    el.form.addEventListener('submit', addMapping);
    el.enabled.addEventListener('change', toggleEnabled);
    el.filter.addEventListener('input', render);
    el.copyBtn.addEventListener('click', copyExport);
    el.importBtn.addEventListener('click', importMappings);

    el.username.focus();
  }

  init();
})();
