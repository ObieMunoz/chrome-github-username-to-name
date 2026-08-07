'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
const COMMON_SRC = read('common.js');
const CONTENT_SRC = read('content.js');
const HOVERCARD_SRC = read('hovercard.js');

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Objects built inside the jsdom realm carry that realm's prototype, which
 * strict deepEqual treats as a mismatch. Copy into this realm before comparing.
 */
const plain = (object) => ({ ...object });

function setup({ mappings = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const store = { ghun: { enabled: true, mappings } };

  // content.js uses the callback form, hovercard.js the promise form.
  window.chrome = {
    runtime: { id: 'test-extension', lastError: null },
    storage: {
      sync: {
        get(key, callback) {
          const value = { [key]: store[key] };
          if (typeof callback === 'function') return callback(value);
          return Promise.resolve(value);
        },
        set(items, callback) {
          Object.assign(store, items);
          if (typeof callback === 'function') callback();
          return Promise.resolve();
        },
      },
      onChanged: { addListener() {} },
    },
  };

  window.eval(COMMON_SRC);
  window.eval(CONTENT_SRC);
  window.eval(HOVERCARD_SRC);

  return { window, store };
}

function hover(window, element) {
  element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

/** Mimic GitHub: hover a trigger, then the card is injected asynchronously. */
async function showHovercard(window, hovercardUrl) {
  const trigger = window.document.createElement('a');
  trigger.setAttribute('href', '/someone');
  trigger.setAttribute('data-hovercard-url', hovercardUrl);
  window.document.getElementById('app').appendChild(trigger);
  hover(window, trigger);

  const card = window.document.createElement('div');
  card.className = 'js-hovercard-content';
  card.innerHTML = '<div class="Popover-message"><p>Bio goes here</p></div>';
  window.document.body.appendChild(card);

  await tick();
  return card;
}

test('adds a row to the user hovercard', async () => {
  const { window } = setup();
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  const row = card.querySelector('.ghun-card-row');
  assert.ok(row, 'expected a row to be injected');
  assert.match(row.textContent, /Show as a real name/);
  assert.equal(row.dataset.ghunFor, 'u1069002');
});

test('shows the existing name when one is already mapped', async () => {
  const { window } = setup({ mappings: { u1069002: 'Obie Munoz' } });
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  assert.match(card.querySelector('.ghun-card-row').textContent, /Showing as “Obie Munoz”/);
});

test('does not add a row to an organization hovercard', async () => {
  const { window } = setup();
  await showHovercard(window, '/users/u1069002/hovercard');
  const orgCard = await showHovercard(window, '/orgs/github/hovercard');

  // The org card must not inherit the previously hovered user.
  assert.equal(orgCard.querySelector('.ghun-card-row'), null);
});

test('replaces a stale row when the card is reused for another user', async () => {
  const { window } = setup();
  const card = await showHovercard(window, '/users/u1069002/hovercard');
  assert.equal(card.querySelector('.ghun-card-row').dataset.ghunFor, 'u1069002');

  // Hover a different user, then GitHub swaps the card's contents.
  const trigger = window.document.createElement('a');
  trigger.setAttribute('data-hovercard-url', '/users/octocat/hovercard');
  window.document.getElementById('app').appendChild(trigger);
  hover(window, trigger);

  card.querySelector('.Popover-message').innerHTML = '<p>Another bio</p>';
  await tick();

  const rows = card.querySelectorAll('.ghun-card-row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.ghunFor, 'octocat');
});

test('the editor panel opens outside the hovercard so it survives teardown', async () => {
  const { window } = setup();
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  const panel = window.document.getElementById('ghun-panel');

  assert.ok(panel, 'expected the panel to open');
  assert.equal(panel.parentElement, window.document.body);
  assert.equal(card.contains(panel), false);
  assert.equal(panel.querySelector('.ghun-panel-title').textContent, 'u1069002');

  // GitHub removes the hovercard on mouseout; the panel must outlive it.
  card.remove();
  assert.ok(window.document.getElementById('ghun-panel'));
});

test('anchors itself inline so a missing stylesheet cannot drop it into page flow', async () => {
  const { window } = setup();
  const card = await showHovercard(window, '/users/u1069002/hovercard');
  click(window, card.querySelector('.ghun-card-button'));

  const panel = window.document.getElementById('ghun-panel');
  assert.equal(panel.style.position, 'fixed');
  assert.ok(panel.style.zIndex);
  assert.ok(panel.style.top !== '' && panel.style.left !== '');
});

test('saving writes the mapping to storage', async () => {
  const { window, store } = setup();
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  const panel = window.document.getElementById('ghun-panel');
  panel.querySelector('.ghun-panel-input').value = 'Obie Munoz';
  click(window, panel.querySelector('.ghun-panel-save'));
  await tick();

  assert.equal(store.ghun.mappings.u1069002, 'Obie Munoz');
  assert.equal(window.document.getElementById('ghun-panel'), null);
});

test('saving preserves mappings added elsewhere in the meantime', async () => {
  const { window, store } = setup({ mappings: { octocat: 'The Octocat' } });
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  const panel = window.document.getElementById('ghun-panel');
  panel.querySelector('.ghun-panel-input').value = 'Obie Munoz';

  // A concurrent write from the popup lands before we commit.
  store.ghun = { enabled: true, mappings: { octocat: 'The Octocat', hubot: 'Hubot' } };
  click(window, panel.querySelector('.ghun-panel-save'));
  await tick();

  assert.deepEqual(plain(store.ghun.mappings), {
    octocat: 'The Octocat',
    hubot: 'Hubot',
    u1069002: 'Obie Munoz',
  });
});

test('relabels the open hovercard row after saving', async () => {
  const { window } = setup();
  const card = await showHovercard(window, '/users/u1069002/hovercard');
  assert.match(card.querySelector('.ghun-card-row').textContent, /Show as a real name/);

  click(window, card.querySelector('.ghun-card-button'));
  const panel = window.document.getElementById('ghun-panel');
  panel.querySelector('.ghun-panel-input').value = 'Obie Munoz';
  click(window, panel.querySelector('.ghun-panel-save'));
  await tick();

  // The card is still open behind the panel and must not read as unmapped.
  assert.match(card.querySelector('.ghun-card-row').textContent, /Showing as “Obie Munoz”/);
});

test('Remove clears an existing mapping', async () => {
  const { window, store } = setup({ mappings: { u1069002: 'Obie Munoz' } });
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  click(window, window.document.getElementById('ghun-panel').querySelector('.ghun-panel-remove'));
  await tick();

  assert.deepEqual(plain(store.ghun.mappings), {});
});

test('the panel is excluded from username replacement', async () => {
  // The title must keep showing the raw username, not the mapped name.
  const { window } = setup({ mappings: { u1069002: 'Obie Munoz' } });
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  await tick();

  const panel = window.document.getElementById('ghun-panel');
  assert.equal(panel.querySelector('.ghun-panel-title').textContent, 'u1069002');
  assert.equal(panel.querySelectorAll('span.ghun-name').length, 0);
});
