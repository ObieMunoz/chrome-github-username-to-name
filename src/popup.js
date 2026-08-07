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
    PENDING_KEY,
    normalizeUsername,
    isValidUsername,
    coerceSettings,
    parseImport,
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
    exportBtn: document.getElementById('export'),
    importBtn: document.getElementById('import'),
    importFile: document.getElementById('import-file'),
  };

  let settings = { enabled: true, mappings: {} };
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

    if (await save()) {
      render();
      const skipped = parsed.skipped ? `, ${parsed.skipped} skipped` : '';
      showStatus(`Imported ${incoming.length} name${incoming.length === 1 ? '' : 's'}${skipped}.`);
    }
  }

  /** Pick up a username handed over by the context menu. */
  async function consumePending() {
    const result = await chrome.storage.local.get(PENDING_KEY);
    const username = result[PENDING_KEY];
    if (!username) return;

    await chrome.storage.local.remove(PENDING_KEY);
    el.username.value = username;

    const existing = settings.mappings[normalizeUsername(username)];
    if (existing) el.replacement.value = existing;
    el.replacement.focus();
    el.replacement.select();
  }

  // --- wiring ----------------------------------------------------------------

  async function init() {
    settings = await load();
    render();

    el.form.addEventListener('submit', addMapping);
    el.enabled.addEventListener('change', toggleEnabled);
    el.filter.addEventListener('input', render);
    el.exportBtn.addEventListener('click', exportMappings);
    el.importBtn.addEventListener('click', () => el.importFile.click());
    el.importFile.addEventListener('change', importMappings);

    await consumePending();
  }

  init();
})();
