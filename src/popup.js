/**
 * Popup UI: manage the username -> real name mappings.
 *
 * All rendering goes through textContent, never innerHTML, so a replacement
 * containing markup can't inject anything into this page.
 */
(function () {
  'use strict';

  const {
    STORAGE_KEY,
    DEFAULT_COLORS,
    THEME_BACKGROUNDS,
    MIN_CONTRAST,
    normalizeUsername,
    isValidUsername,
    coerceSettings,
    parseImport,
    parseHex,
    toHex,
    rgbToHsl,
    hslToRgb,
    contrastRatio,
    deriveThemeColors,
  } = globalThis.GHUN;

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
    wheel: document.getElementById('wheel'),
    marker: document.getElementById('wheel-marker'),
    lightness: document.getElementById('lightness'),
    hex: document.getElementById('hex'),
    chips: [document.getElementById('chip-dark'), document.getElementById('chip-light')],
    note: document.getElementById('color-note'),
    colorReset: document.getElementById('color-reset'),
    exportBtn: document.getElementById('export'),
    importBtn: document.getElementById('import'),
    importFile: document.getElementById('import-file'),
  };

  let settings = { enabled: true, mappings: {}, color: null };
  let statusTimer = null;

  // --- storage ---------------------------------------------------------------

  function load() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(STORAGE_KEY, (result) => {
        resolve(coerceSettings(result[STORAGE_KEY]));
      });
    });
  }

  function save() {
    return new Promise((resolve) => {
      chrome.storage.sync.set({ [STORAGE_KEY]: settings }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          // The whole map lives in one sync item, capped at 8KB.
          showStatus(
            /quota/i.test(error.message)
              ? 'Out of sync storage. Export a backup, then remove a few entries.'
              : `Could not save: ${error.message}`,
            true
          );
          resolve(false);
          return;
        }
        resolve(true);
      });
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

  /** GitHub's own muted and danger foregrounds, one pair per preview backdrop. */
  const CHIP_TEXT = {
    dark: { muted: '#8b949e', danger: '#f85149' },
    light: { muted: '#57606a', danger: '#cf222e' },
  };

  /**
   * The live pick, kept in HSL rather than as a hex string: the wheel maps angle
   * to hue and radius to saturation, and round-tripping through hex would lose
   * both whenever the color passes through black, white or grey.
   */
  let picker = { h: 0, s: 0, l: 0.5, theme: 'dark' };

  /** Lightness the wheel was last painted at, so drags don't repaint needlessly. */
  let paintedLightness = null;
  let colorSaveTimer = null;

  function currentHex() {
    return toHex(hslToRgb(picker));
  }

  /**
   * Which theme the pick applies to.
   *
   * GitHub follows the OS setting unless it has been overridden in GitHub's own
   * appearance settings, so this is the best guess available from inside the
   * popup — and the preview chips are clickable, so a wrong guess costs a click.
   */
  function detectTheme() {
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function setPicker(hex, theme) {
    const rgb = parseHex(hex);
    if (!rgb) return;

    const hsl = rgbToHsl(rgb);
    picker = {
      // A grey reports hue 0; keeping the old one leaves the wheel where it was
      // instead of snapping the marker onto the red axis.
      h: hsl.s === 0 ? picker.h : hsl.h,
      s: hsl.s,
      l: hsl.l,
      theme: theme || picker.theme,
    };
  }

  /** Start from the stored pick, or from the default for the detected theme. */
  function initPicker() {
    const theme = settings.color ? settings.color.theme : detectTheme();
    setPicker(settings.color ? settings.color.base : DEFAULT_COLORS[theme], theme);
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
   * maths uses, so the point under the cursor is exactly the value stored — a
   * CSS gradient approximation would drift from it.
   */
  function drawWheel(lightness) {
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
          l: lightness,
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
    paintedLightness = lightness;
  }

  function positionMarker() {
    const radius = WHEEL_SIZE / 2;
    const angle = (picker.h * Math.PI) / 180;
    el.marker.style.left = `${radius + Math.cos(angle) * picker.s * radius}px`;
    el.marker.style.top = `${radius - Math.sin(angle) * picker.s * radius}px`;
    el.marker.style.background = currentHex();
  }

  function renderChip(chip, color) {
    const theme = chip.dataset.theme;
    const ratio = contrastRatio(color, THEME_BACKGROUNDS[theme]);
    const selected = picker.theme === theme;

    chip.classList.toggle('selected', selected);
    chip.setAttribute('aria-pressed', String(selected));
    chip.style.background = THEME_BACKGROUNDS[theme];
    chip.title = selected
      ? `${color} — picked for the ${theme} theme`
      : `${color} — derived for the ${theme} theme. Click to edit this one instead.`;

    const sample = chip.querySelector('.chip-sample');
    sample.textContent = sampleName();
    sample.style.color = color;

    const meta = chip.querySelector('.chip-meta');
    meta.textContent = `${ratio.toFixed(1)}:1`;
    meta.style.color = CHIP_TEXT[theme][ratio < MIN_CONTRAST ? 'danger' : 'muted'];
  }

  /** A real mapping makes the preview concrete; otherwise a stand-in. */
  function sampleName() {
    const first = sortedEntries()[0];
    return first ? first[1] : 'Real Name';
  }

  function renderColor() {
    const base = currentHex();
    const colors = deriveThemeColors(base, picker.theme);
    const other = picker.theme === 'dark' ? 'light' : 'dark';

    if (picker.l !== paintedLightness) drawWheel(picker.l);
    positionMarker();

    el.lightness.value = String(Math.round(picker.l * 100));
    el.lightness.style.setProperty(
      '--track-color',
      toHex(hslToRgb({ h: picker.h, s: picker.s, l: 0.5 }))
    );

    // Leave the field alone mid-typing, or the caret jumps on every keystroke.
    if (document.activeElement !== el.hex) el.hex.value = base;

    for (const chip of el.chips) renderChip(chip, colors[chip.dataset.theme]);

    const ratio = contrastRatio(base, THEME_BACKGROUNDS[picker.theme]);
    const readable = ratio >= MIN_CONTRAST;
    el.note.classList.toggle('warn', !readable);
    el.note.textContent = readable
      ? `Picked for the ${picker.theme} theme. The ${other} variant is derived to stay readable.`
      : `${ratio.toFixed(1)}:1 on the ${picker.theme} theme is below the ${MIN_CONTRAST}:1 readability floor.`;

    // The popup is always dark, so its own accent follows the dark variant.
    document.documentElement.style.setProperty('--neon', colors.dark);
    el.swatch.style.background = colors.dark;
    el.colorReset.hidden = !settings.color;
  }

  /**
   * Dragging fires a lot of events and chrome.storage.sync caps writes per
   * minute, so only the write is debounced. The settings object is updated
   * straight away, which is what keeps the preview and the reset button
   * agreeing with the wheel between one write and the next.
   */
  function commitColor() {
    settings.color = { base: currentHex(), theme: picker.theme };
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
    commitColor();
  }

  const WHEEL_KEYS = {
    ArrowLeft: { h: -4 },
    ArrowRight: { h: 4 },
    ArrowUp: { s: 0.04 },
    ArrowDown: { s: -0.04 },
  };

  /**
   * Hand the wheel to the variant the chip represents. Its current color becomes
   * the new pick, so nothing moves at the moment of the click — only which side
   * is authoritative and which one gets derived from now on.
   */
  function chooseTheme(theme) {
    if (picker.theme === theme) return;
    setPicker(deriveThemeColors(currentHex(), picker.theme)[theme], theme);
    commitColor();
  }

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
      commitColor();
    });

    el.lightness.addEventListener('input', () => {
      picker.l = Number(el.lightness.value) / 100;
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

    for (const chip of el.chips) {
      chip.addEventListener('click', () => chooseTheme(chip.dataset.theme));
    }

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

  function exportMappings() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      enabled: settings.enabled,
      color: settings.color,
      mappings: settings.mappings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `github-username-renamer-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showStatus('Exported.');
  }

  async function importMappings(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;

    let parsed;
    try {
      parsed = parseImport(await file.text());
    } catch (error) {
      showStatus(error.message, true);
      return;
    }

    const incoming = Object.keys(parsed.mappings);
    const overwrites = incoming.filter((username) =>
      Object.prototype.hasOwnProperty.call(settings.mappings, username)
    );

    if (overwrites.length) {
      const proceed = confirm(
        `${overwrites.length} of ${incoming.length} entries already exist and will be ` +
          'overwritten with the imported values.\n\nContinue?'
      );
      if (!proceed) return;
    }

    settings.mappings = { ...settings.mappings, ...parsed.mappings };
    if (typeof parsed.enabled === 'boolean') settings.enabled = parsed.enabled;
    if (parsed.color) settings.color = parsed.color;

    if (await save()) {
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
    wireColorPicker();
    render();

    el.form.addEventListener('submit', addMapping);
    el.enabled.addEventListener('change', toggleEnabled);
    el.filter.addEventListener('input', render);
    el.exportBtn.addEventListener('click', exportMappings);
    el.importBtn.addEventListener('click', () => el.importFile.click());
    el.importFile.addEventListener('change', importMappings);

    el.username.focus();
  }

  init();
})();
