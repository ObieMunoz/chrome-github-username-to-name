'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
const POPUP_HTML = read('popup.html');
const COMMON_SRC = read('common.js');
const STORE_SRC = read('store.js');
const POPUP_SRC = read('popup.js');

const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load the real popup with a chrome stand-in. `collect` answers the active tab's
 * "who is on this page" message, or throws the way Chrome does when no content
 * script is listening.
 */
async function setup({
  mappings = {},
  collect = null,
  origins = ['https://github.com/*'],
  grant = true,
  shortcut = 'Alt+Shift+U',
} = {}) {
  const dom = new JSDOM(POPUP_HTML, { runScripts: 'outside-only', url: 'https://extension.test/src/popup.html' });
  const { window } = dom;
  const items = { ghun: { enabled: true, color: null, mappings } };
  const requests = [];
  const removals = [];
  const messages = [];

  window.HTMLCanvasElement.prototype.getContext = () => ({
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData() {},
  });
  window.scrollTo = () => {};

  window.chrome = {
    runtime: { id: 'test-extension' },
    storage: {
      sync: {
        get: async () => plain(items),
        async set(next) {
          Object.assign(items, plain(next));
        },
        async remove(keys) {
          for (const key of [].concat(keys)) delete items[key];
        },
      },
    },
    tabs: {
      query: async () => [{ id: 3 }],
      async sendMessage(tabId, message) {
        messages.push({ tabId, message: plain(message) });
        if (!collect) throw new Error('Could not establish connection. Receiving end does not exist.');
        return collect;
      },
    },
    permissions: {
      getAll: async () => ({ origins: [...origins], permissions: [] }),
      async request(details) {
        requests.push(plain(details));
        if (grant) origins.push(...details.origins);
        return grant;
      },
      async remove(details) {
        removals.push(plain(details));
        origins = origins.filter((origin) => !details.origins.includes(origin));
        return true;
      },
    },
    commands: {
      getAll: async () => [{ name: 'toggle-replacement', shortcut }],
    },
  };

  window.eval(COMMON_SRC);
  window.eval(STORE_SRC);
  window.eval(POPUP_SRC);
  await settle();

  const $ = (selector) => window.document.querySelector(selector);
  const stored = () => window.GHUN.unpackSettings(items);
  return { window, $, stored, requests, removals, messages };
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

function type(window, input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

const openView = async (window, $, name) => {
  click(window, $(`.nav-row[data-open="${name}"]`));
  await settle();
};

// --- the name list ------------------------------------------------------------

test('the empty state points at the hovercard row, which exists', async () => {
  const { $ } = await setup();
  const text = $('#empty').textContent;

  assert.match(text, /Show as a real name…/);
  assert.doesNotMatch(text, /right-click/i);
});

test('removing a name offers an undo that puts it back', async () => {
  const { window, $, stored } = await setup({ mappings: { octocat: 'The Octocat' } });

  click(window, $('.row .delete'));
  await settle();
  assert.deepEqual(plain(stored().mappings), {});

  const undo = $('#status-action');
  assert.equal(undo.hidden, false);
  assert.equal(undo.textContent, 'Undo');

  click(window, undo);
  await settle();

  assert.deepEqual(plain(stored().mappings), { octocat: 'The Octocat' });
  assert.equal($('.row .name').textContent, 'octocat');
  assert.equal(undo.hidden, true);
});

test('a status without an action shows no action button', async () => {
  const { window, $ } = await setup();

  $('#username').value = 'octocat';
  $('#replacement').value = 'The Octocat';
  submit(window, $('#add-form'));
  await settle();

  assert.equal($('#status').hidden, false);
  assert.equal($('#status-action').hidden, true);
});

test('caps a typed name at a length storage can always hold', async () => {
  const { $ } = await setup({ mappings: { octocat: 'The Octocat' } });

  assert.equal($('#replacement').maxLength, 100);
  assert.equal($('.row input').maxLength, 100);
});

test('the switch names the pause shortcut', async () => {
  const { $ } = await setup();

  assert.match($('.switch').title, /Alt\+Shift\+U/);
});

test('the switch leaves the shortcut out when none is set', async () => {
  const { $ } = await setup({ shortcut: '' });

  assert.doesNotMatch($('.switch').title, /\(/);
});

// --- add from this page -------------------------------------------------------

const PEOPLE = {
  people: [
    { username: 'octocat', name: 'The Octocat' },
    { username: 'hubot', name: '' },
  ],
  truncated: false,
};

test('lists the people on the page with their profile names', async () => {
  const { window, $, messages } = await setup({ collect: PEOPLE });
  await openView(window, $, 'page');

  assert.deepEqual(messages, [{ tabId: 3, message: { type: 'ghun:collect' } }]);
  const rows = window.document.querySelectorAll('#page-list .person');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('.name').textContent, 'octocat');
  assert.equal(rows[0].querySelector('input[type="text"]').value, 'The Octocat');
  assert.equal(rows[0].querySelector('input[type="checkbox"]').checked, true);
  assert.equal(rows[1].querySelector('input[type="checkbox"]').checked, false);
});

test('adds the people who are ticked', async () => {
  const { window, $, stored } = await setup({ mappings: { mona: 'Mona' }, collect: PEOPLE });
  await openView(window, $, 'page');

  click(window, $('#page-add'));
  await settle();

  assert.deepEqual(plain(stored().mappings), { mona: 'Mona', octocat: 'The Octocat' });
  assert.equal($('#view-main').hidden, false);
  assert.match($('#status-text').textContent, /Added 1 name/);
});

test('typing a name ticks that person', async () => {
  const { window, $, stored } = await setup({ collect: PEOPLE });
  await openView(window, $, 'page');

  const [, hubot] = window.document.querySelectorAll('#page-list .person');
  type(window, hubot.querySelector('input[type="text"]'), 'Hubot');
  assert.equal(hubot.querySelector('input[type="checkbox"]').checked, true);

  click(window, $('#page-add'));
  await settle();

  assert.deepEqual(plain(stored().mappings), { octocat: 'The Octocat', hubot: 'Hubot' });
});

test('will not add a ticked person without a name', async () => {
  const { window, $, stored } = await setup({ collect: PEOPLE });
  await openView(window, $, 'page');

  const [, hubot] = window.document.querySelectorAll('#page-list .person');
  hubot.querySelector('input[type="checkbox"]').checked = true;
  click(window, $('#page-add'));
  await settle();

  assert.deepEqual(plain(stored().mappings), {});
  assert.match($('#status-text').textContent, /hubot/);
  assert.equal(window.document.activeElement, hubot.querySelector('input[type="text"]'));
});

test('says when the tab is not a GitHub page', async () => {
  const { window, $ } = await setup({ collect: null });
  await openView(window, $, 'page');

  assert.match($('#page-note').textContent, /Open a GitHub page/);
  assert.equal($('#page-add').hidden, true);
});

test('says when everyone on the page already has a name', async () => {
  const { window, $ } = await setup({ collect: { people: [], truncated: false } });
  await openView(window, $, 'page');

  assert.match($('#page-note').textContent, /already has a name/);
  assert.equal($('#page-add').hidden, true);
});

test('says when the list was cut short', async () => {
  const { window, $ } = await setup({ collect: { ...PEOPLE, truncated: true } });
  await openView(window, $, 'page');

  assert.match($('#page-note').textContent, /first/);
});

// --- GitHub Enterprise hosts --------------------------------------------------

test('lists the Enterprise hosts already granted', async () => {
  const { window, $ } = await setup({
    origins: ['https://github.com/*', 'https://github.example.com/*'],
  });
  await openView(window, $, 'hosts');

  const rows = window.document.querySelectorAll('#host-list .host');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('.name').textContent, 'github.example.com');
  assert.equal($('#host-empty').hidden, true);
});

test('adding a host asks Chrome for just that host', async () => {
  const { window, $, requests } = await setup();
  await openView(window, $, 'hosts');

  $('#host').value = 'https://GitHub.Example.com/some/page';
  submit(window, $('#host-form'));
  await settle();

  assert.deepEqual(requests, [{ origins: ['https://github.example.com/*'] }]);
  assert.equal(window.document.querySelectorAll('#host-list .host').length, 1);
  assert.match($('#status-text').textContent, /Reload/);
  assert.equal($('#host').value, '');
});

test('says so when Chrome is not given the host', async () => {
  const { window, $ } = await setup({ grant: false });
  await openView(window, $, 'hosts');

  $('#host').value = 'github.example.com';
  submit(window, $('#host-form'));
  await settle();

  assert.equal(window.document.querySelectorAll('#host-list .host').length, 0);
  assert.equal($('#status').classList.contains('error'), true);
});

test('refuses a host it cannot serve without asking Chrome', async () => {
  const { window, $, requests } = await setup();
  await openView(window, $, 'hosts');

  $('#host').value = 'github.com';
  submit(window, $('#host-form'));
  await settle();

  assert.deepEqual(requests, []);
  assert.equal($('#status').classList.contains('error'), true);
});

test('removing a host gives up its permission', async () => {
  const { window, $, removals } = await setup({
    origins: ['https://github.com/*', 'https://github.example.com/*'],
  });
  await openView(window, $, 'hosts');

  click(window, $('#host-list .host .delete'));
  await settle();

  assert.deepEqual(removals, [{ origins: ['https://github.example.com/*'] }]);
  assert.equal(window.document.querySelectorAll('#host-list .host').length, 0);
  assert.equal($('#host-empty').hidden, false);
});
