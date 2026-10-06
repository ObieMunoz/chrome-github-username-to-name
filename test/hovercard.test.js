'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
const COMMON_SRC = read('common.js');
const STORE_SRC = read('store.js');
const CONTENT_SRC = read('content.js');
const HOVERCARD_SRC = read('hovercard.js');

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Objects built inside the jsdom realm carry that realm's prototype, which
 * strict deepEqual treats as a mismatch. Copy into this realm before comparing.
 */
const plain = (object) => ({ ...object });

function setup({ mappings = {}, failWrites = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    runScripts: 'outside-only',
  });
  const { window } = dom;
  const items = { ghun: { enabled: true, mappings } };

  window.chrome = {
    runtime: { id: 'test-extension', lastError: null },
    storage: {
      sync: {
        get: async () => JSON.parse(JSON.stringify(items)),
        async set(next) {
          if (failWrites) throw new Error(failWrites);
          Object.assign(items, JSON.parse(JSON.stringify(next)));
        },
        async remove(keys) {
          for (const key of [].concat(keys)) delete items[key];
        },
      },
      onChanged: { addListener() {} },
    },
  };

  window.eval(COMMON_SRC);
  window.eval(STORE_SRC);
  window.eval(CONTENT_SRC);
  window.eval(HOVERCARD_SRC);

  const stored = () => window.GHUN.unpackSettings(items);
  return { window, items, stored };
}

function hover(window, element) {
  element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
}

function click(window, element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

/** Mimic GitHub: hover a trigger, then the card is injected asynchronously. */
async function showHovercard(window, hovercardUrl, { body = '<p>Bio goes here</p>' } = {}) {
  const trigger = window.document.createElement('a');
  trigger.setAttribute('href', '/someone');
  trigger.setAttribute('data-hovercard-url', hovercardUrl);
  window.document.getElementById('app').appendChild(trigger);
  hover(window, trigger);

  const card = window.document.createElement('div');
  card.className = 'js-hovercard-content';
  card.innerHTML = `<div class="Popover-message">${body}</div>`;
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
  await tick();
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
  const { window, stored } = setup();
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  const panel = window.document.getElementById('ghun-panel');
  panel.querySelector('.ghun-panel-input').value = 'Obie Munoz';
  click(window, panel.querySelector('.ghun-panel-save'));
  await tick();

  assert.equal(stored().mappings.u1069002, 'Obie Munoz');
  assert.equal(window.document.getElementById('ghun-panel'), null);
});

test('saving preserves mappings added elsewhere in the meantime', async () => {
  const { window, items, stored } = setup({ mappings: { octocat: 'The Octocat' } });
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  const panel = window.document.getElementById('ghun-panel');
  panel.querySelector('.ghun-panel-input').value = 'Obie Munoz';

  // A concurrent write from the popup lands before we commit.
  items.ghun = { enabled: true, mappings: { octocat: 'The Octocat', hubot: 'Hubot' } };
  click(window, panel.querySelector('.ghun-panel-save'));
  await tick();

  assert.deepEqual(plain(stored().mappings), {
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
  const { window, stored } = setup({ mappings: { u1069002: 'Obie Munoz' } });
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  click(window, window.document.getElementById('ghun-panel').querySelector('.ghun-panel-remove'));
  await tick();

  assert.deepEqual(plain(stored().mappings), {});
});

test('saves in the chunked format, leaving the old single item behind', async () => {
  const { window, items } = setup({ mappings: { octocat: 'The Octocat' } });
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  const panel = window.document.getElementById('ghun-panel');
  panel.querySelector('.ghun-panel-input').value = 'Obie Munoz';
  click(window, panel.querySelector('.ghun-panel-save'));
  await tick();

  assert.equal('mappings' in items.ghun, false);
  assert.deepEqual(plain(items['ghun.m.0']), { octocat: 'The Octocat', u1069002: 'Obie Munoz' });
});

test('a failed save keeps the panel open and says why', async () => {
  const { window } = setup({ failWrites: 'QUOTA_BYTES quota exceeded' });
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  const panel = window.document.getElementById('ghun-panel');
  panel.querySelector('.ghun-panel-input').value = 'Obie Munoz';
  click(window, panel.querySelector('.ghun-panel-save'));
  await tick();

  assert.equal(window.document.getElementById('ghun-panel'), panel);
  assert.equal(panel.querySelector('.ghun-panel-input').value, 'Obie Munoz');
  assert.match(panel.querySelector('.ghun-panel-error').textContent, /storage is full/i);
  assert.match(card.querySelector('.ghun-card-row').textContent, /Show as a real name/);
});

test('a failed save reports errors other than a full store as they are', async () => {
  const { window } = setup({ failWrites: 'MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded' });
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  const panel = window.document.getElementById('ghun-panel');
  panel.querySelector('.ghun-panel-input').value = 'Obie Munoz';
  click(window, panel.querySelector('.ghun-panel-save'));
  await tick();

  assert.match(panel.querySelector('.ghun-panel-error').textContent, /MAX_WRITE_OPERATIONS_PER_MINUTE/);
});

test('fills the editor with the profile name the card shows', async () => {
  const { window } = setup();
  const card = await showHovercard(window, '/users/u1069002/hovercard', {
    body: '<a href="/u1069002"><img alt="@u1069002"></a>' +
      '<a href="/u1069002">Obie Munoz</a> <a href="/u1069002">u1069002</a>',
  });

  click(window, card.querySelector('.ghun-card-button'));

  const input = window.document.querySelector('#ghun-panel .ghun-panel-input');
  assert.equal(input.value, 'Obie Munoz');
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, 'Obie Munoz'.length);
});

test('prefers the name already mapped over the profile name', async () => {
  const { window } = setup({ mappings: { u1069002: 'Obie' } });
  await tick();
  const card = await showHovercard(window, '/users/u1069002/hovercard', {
    body: '<a href="/u1069002">Obie Munoz</a> <a href="/u1069002">u1069002</a>',
  });

  click(window, card.querySelector('.ghun-card-button'));

  assert.equal(window.document.querySelector('#ghun-panel .ghun-panel-input').value, 'Obie');
});

test('leaves the editor empty when the profile has no name of its own', async () => {
  const { window } = setup();
  const card = await showHovercard(window, '/users/u1069002/hovercard', {
    body: '<a href="/u1069002">u1069002</a> <a href="/u1069002">@U1069002</a> <a href="/octocat">The Octocat</a>',
  });

  click(window, card.querySelector('.ghun-card-button'));

  assert.equal(window.document.querySelector('#ghun-panel .ghun-panel-input').value, '');
});

test('fills the editor from a React card in the portal', async () => {
  const { window } = setup();
  hoverProfileLink(window, '/u1069002');
  const overlay = window.document.createElement('div');
  overlay.innerHTML = '<div><a href="/u1069002">Obie Munoz</a><a href="/u1069002">u1069002</a></div>';
  portalFor(window).appendChild(overlay);
  await tick();

  click(window, overlay.querySelector('.ghun-card-button'));

  assert.equal(window.document.querySelector('#ghun-panel .ghun-panel-input').value, 'Obie Munoz');
});

test('Remove offers an undo that puts the name back', async () => {
  const { window, stored } = setup({ mappings: { u1069002: 'Obie Munoz' } });
  await tick();
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  click(window, window.document.getElementById('ghun-panel').querySelector('.ghun-panel-remove'));
  await tick();

  const toast = window.document.getElementById('ghun-toast');
  assert.ok(toast, 'expected an undo toast');
  assert.equal(toast.parentElement, window.document.body);
  assert.match(toast.textContent, /u1069002/);

  click(window, toast.querySelector('.ghun-toast-undo'));
  await tick();

  assert.equal(stored().mappings.u1069002, 'Obie Munoz');
  assert.equal(window.document.getElementById('ghun-toast'), null);
  assert.match(card.querySelector('.ghun-card-row').textContent, /Showing as “Obie Munoz”/);
});

test('the undo toast is excluded from username replacement', async () => {
  const { window } = setup({ mappings: { u1069002: 'Obie Munoz', octocat: 'The Octocat' } });
  await tick();
  const card = await showHovercard(window, '/users/octocat/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  click(window, window.document.getElementById('ghun-panel').querySelector('.ghun-panel-remove'));
  await tick();

  const toast = window.document.getElementById('ghun-toast');
  assert.ok(toast.hasAttribute('data-ghun-ui'));
  assert.equal(toast.style.position, 'fixed');
});

test('the panel copies the raw username', async () => {
  const { window } = setup();
  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async (text) => copied.push(text) },
  });
  const card = await showHovercard(window, '/users/u1069002/hovercard');

  click(window, card.querySelector('.ghun-card-button'));
  const copy = window.document.querySelector('#ghun-panel .ghun-panel-copy');
  click(window, copy);
  await tick();

  assert.deepEqual(copied, ['u1069002']);
  assert.match(copy.textContent, /Copied/);
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

/* ---------------------------------------------------------------------------
 * The React hovercard: an overlay in the Primer portal (or a native popover),
 * triggered from a plain profile link with no data-hovercard-url.
 * ------------------------------------------------------------------------- */

function hoverProfileLink(window, href) {
  const trigger = window.document.createElement('a');
  trigger.setAttribute('href', href);
  window.document.getElementById('app').appendChild(trigger);
  hover(window, trigger);
  return trigger;
}

function portalFor(window) {
  let portal = window.document.getElementById('__primerPortalRoot__');
  if (!portal) {
    portal = window.document.createElement('div');
    portal.id = '__primerPortalRoot__';
    window.document.body.appendChild(portal);
  }
  return portal;
}

/** Mimic the React flow: hover a plain link, then an overlay lands in the portal. */
async function showPortalHovercard(window, username, { linkTo = username } = {}) {
  hoverProfileLink(window, `/${username}`);

  const overlay = window.document.createElement('div');
  overlay.innerHTML = `<div><a href="/${linkTo}">${linkTo}</a><p>Bio goes here</p></div>`;
  portalFor(window).appendChild(overlay);

  await tick();
  return overlay;
}

test('adds a row to a portal hovercard opened from a plain profile link', async () => {
  const { window } = setup();
  const overlay = await showPortalHovercard(window, 'u1069002');

  const row = overlay.querySelector('.ghun-card-row');
  assert.ok(row, 'expected a row in the portal overlay');
  assert.ok(row.classList.contains('ghun-card-overlay'));
  assert.equal(row.dataset.ghunFor, 'u1069002');
  assert.match(row.textContent, /Show as a real name/);
});

test('enhances a portal hovercard whose content arrives after its shell', async () => {
  const { window } = setup();
  hoverProfileLink(window, '/u1069002');

  const overlay = window.document.createElement('div');
  portalFor(window).appendChild(overlay);
  await tick();
  // An empty shell is not identifiable as anyone's hovercard yet.
  assert.equal(overlay.querySelector('.ghun-card-row'), null);

  const content = window.document.createElement('div');
  content.innerHTML = '<a href="/u1069002">u1069002</a>';
  overlay.appendChild(content);
  await tick();

  assert.equal(overlay.querySelector('.ghun-card-row').dataset.ghunFor, 'u1069002');
});

test('adds a row to a native-popover hovercard', async () => {
  const { window } = setup();
  hoverProfileLink(window, '/u1069002');

  const overlay = window.document.createElement('div');
  overlay.setAttribute('popover', 'auto');
  overlay.innerHTML = '<a href="/u1069002">u1069002</a>';
  window.document.body.appendChild(overlay);
  await tick();

  assert.equal(overlay.querySelector('.ghun-card-row').dataset.ghunFor, 'u1069002');
});

test('replaces a stale row when a portal overlay is reused for another user', async () => {
  const { window } = setup();
  const overlay = await showPortalHovercard(window, 'u1069002');
  assert.equal(overlay.querySelector('.ghun-card-row').dataset.ghunFor, 'u1069002');

  hoverProfileLink(window, '/octocat');
  const swapped = window.document.createElement('div');
  swapped.innerHTML = '<a href="/octocat">octocat</a>';
  overlay.appendChild(swapped);
  await tick();

  const rows = overlay.querySelectorAll('.ghun-card-row');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.ghunFor, 'octocat');
});

test('a click between hover and overlay marks a menu, not a hovercard', async () => {
  const { window } = setup();
  hoverProfileLink(window, '/u1069002');
  window.document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));

  const overlay = window.document.createElement('div');
  overlay.innerHTML = '<a href="/u1069002">u1069002</a>';
  portalFor(window).appendChild(overlay);
  await tick();

  assert.equal(overlay.querySelector('.ghun-card-row'), null);
});

test('an overlay with form fields is a dialog, not a hovercard', async () => {
  const { window } = setup();
  hoverProfileLink(window, '/u1069002');

  const overlay = window.document.createElement('div');
  overlay.innerHTML = '<input type="text" placeholder="Filter"><a href="/u1069002">x</a>';
  portalFor(window).appendChild(overlay);
  await tick();

  assert.equal(overlay.querySelector('.ghun-card-row'), null);
});

test('an overlay that does not link to the hovered user is left alone', async () => {
  const { window } = setup();
  const overlay = await showPortalHovercard(window, 'u1069002', { linkTo: 'someone-else' });

  assert.equal(overlay.querySelector('.ghun-card-row'), null);
});

test('an overlay long after the hover is not that hover’s card', async () => {
  const { window } = setup();
  hoverProfileLink(window, '/u1069002');

  const realNow = window.Date.now();
  window.Date.now = () => realNow + 60000;

  const overlay = window.document.createElement('div');
  overlay.innerHTML = '<a href="/u1069002">u1069002</a>';
  portalFor(window).appendChild(overlay);
  await tick();

  assert.equal(overlay.querySelector('.ghun-card-row'), null);
});

test('an annotated org trigger suppresses the portal fallback too', async () => {
  const { window } = setup();

  // GitHub's own annotation says this is an org, whatever the href looks like.
  const trigger = window.document.createElement('a');
  trigger.setAttribute('href', '/github');
  trigger.setAttribute('data-hovercard-url', '/orgs/github/hovercard');
  window.document.getElementById('app').appendChild(trigger);
  hover(window, trigger);

  const overlay = window.document.createElement('div');
  overlay.innerHTML = '<a href="/github">github</a>';
  portalFor(window).appendChild(overlay);
  await tick();

  assert.equal(overlay.querySelector('.ghun-card-row'), null);
});

test('a portal row opens the same editor panel', async () => {
  const { window, stored } = setup();
  const overlay = await showPortalHovercard(window, 'u1069002');

  click(window, overlay.querySelector('.ghun-card-button'));
  const panel = window.document.getElementById('ghun-panel');
  assert.equal(panel.querySelector('.ghun-panel-title').textContent, 'u1069002');

  panel.querySelector('.ghun-panel-input').value = 'Obie Munoz';
  click(window, panel.querySelector('.ghun-panel-save'));
  await tick();

  assert.equal(stored().mappings.u1069002, 'Obie Munoz');
  assert.match(overlay.querySelector('.ghun-card-row').textContent, /Showing as “Obie Munoz”/);
});

test('keeps enhancing after soft navigation swaps the whole <body>', async () => {
  const { window } = setup();
  const doc = window.document;

  const fresh = doc.createElement('body');
  fresh.innerHTML = '<div id="app"></div>';
  doc.documentElement.replaceChild(fresh, doc.body);
  await tick();

  const card = await showHovercard(window, '/users/u1069002/hovercard');
  assert.ok(card.querySelector('.ghun-card-row'), 'expected the observer to survive a body swap');
});
