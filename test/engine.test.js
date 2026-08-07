'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const COMMON_SRC = fs.readFileSync(path.join(__dirname, '../src/common.js'), 'utf8');
const CONTENT_SRC = fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8');

const MAPPINGS = { u1069002: 'Obie Munoz' };

/**
 * Build a page, load the real content script into it, and run one scan.
 * `chromeStub` is omitted by default so the script does not self-start.
 */
function setup(bodyHtml, { mappings = MAPPINGS, enabled = true, chromeStub = null } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
  });
  const { window } = dom;

  window.eval(COMMON_SRC);
  if (chromeStub) window.chrome = chromeStub(window);
  window.eval(CONTENT_SRC);

  if (!chromeStub) {
    window.GHUN_ENGINE.applySettings({ enabled, mappings }, { rescan: false });
    window.GHUN_ENGINE.scan(window.document.body);
  }
  return window;
}

const $ = (window, selector) => window.document.querySelector(selector);
const replacedSpans = (window) => window.document.querySelectorAll('span.ghun-name');

// --- the safety rules ------------------------------------------------------

test('never rewrites textarea contents', () => {
  // The comment box is a real textarea; a rewrite here would change what the
  // user actually submits to GitHub.
  const window = setup('<textarea id="c">cc @u1069002 please review</textarea>');
  assert.equal($(window, '#c').value, 'cc @u1069002 please review');
  assert.equal(replacedSpans(window).length, 0);
});

test('never rewrites contenteditable regions', () => {
  const window = setup('<div id="c" contenteditable="true"><p>ping u1069002</p></div>');
  assert.equal($(window, '#c').textContent, 'ping u1069002');
  assert.equal(replacedSpans(window).length, 0);
});

test('never rewrites code or pre blocks', () => {
  const window = setup(
    '<pre id="p"><code>git blame --author=u1069002</code></pre>' +
      '<p id="t">reviewed by u1069002</p>'
  );
  assert.equal($(window, '#p').textContent, 'git blame --author=u1069002');
  // The surrounding prose still gets replaced.
  assert.equal($(window, '#t').textContent, 'reviewed by Obie Munoz');
});

test('never rewrites text that is a URL', () => {
  const window = setup('<p id="t">https://github.com/u1069002</p>');
  assert.equal($(window, '#t').textContent, 'https://github.com/u1069002');
});

test('leaves a repo name alone when it matches its owner', () => {
  // The real breadcrumb for github.com/ObieMunoz/obiemunoz.com: the owner is a
  // person and should be replaced, the repo slug is an identifier and must not.
  const window = setup(
    '<span id="crumb">' +
      '<a id="owner" href="/obiemunoz">obiemunoz</a> / ' +
      '<a id="repo" href="/obiemunoz/obiemunoz.com">obiemunoz.com</a>' +
      '</span>',
    { mappings: { obiemunoz: 'Obie Munoz' } }
  );

  assert.equal($(window, '#owner').textContent, 'Obie Munoz');
  assert.equal($(window, '#repo').textContent, 'obiemunoz.com');
});

test('leaves a repo named exactly like its owner alone', () => {
  const window = setup('<a id="repo" href="/obiemunoz/obiemunoz">obiemunoz</a>', {
    mappings: { obiemunoz: 'Obie Munoz' },
  });
  assert.equal($(window, '#repo').textContent, 'obiemunoz');
});

test('still replaces mentions inside deeper repo links', () => {
  // A PR title can legitimately name someone; only the repo root is skipped.
  const window = setup(
    '<a id="pr" href="/obiemunoz/site/pull/12">fix reported by obiemunoz</a>',
    { mappings: { obiemunoz: 'Obie Munoz' } }
  );
  assert.equal($(window, '#pr').textContent, 'fix reported by Obie Munoz');
});

test('leaves the profile link href untouched', () => {
  const window = setup('<a id="a" href="/u1069002" class="author">u1069002</a>');
  const link = $(window, '#a');
  assert.equal(link.getAttribute('href'), '/u1069002');
  assert.equal(link.textContent, 'Obie Munoz');
  assert.equal(link.querySelector('span.ghun-name').getAttribute('data-ghun-user'), 'u1069002');
});

// --- replacement behaviour --------------------------------------------------

test('replaces a bare username and keeps surrounding text', () => {
  const window = setup('<p id="t">opened by u1069002 3 hours ago</p>');
  assert.equal($(window, '#t').textContent, 'opened by Obie Munoz 3 hours ago');
});

test('keeps the @ on a mention', () => {
  const window = setup('<p id="t">cc @u1069002 for review</p>');
  assert.equal($(window, '#t').textContent, 'cc @Obie Munoz for review');
});

test('exposes the original username as a tooltip', () => {
  const window = setup('<p>cc @u1069002</p>');
  const span = replacedSpans(window)[0];
  assert.equal(span.getAttribute('title'), '@u1069002');
  assert.equal(span.getAttribute('data-ghun-raw'), '@u1069002');
  assert.equal(span.getAttribute('data-ghun-user'), 'u1069002');
});

test('replaces every occurrence across a realistic page', () => {
  const window = setup(`
    <div class="pr-row"><a href="/u1069002">u1069002</a> opened #42</div>
    <div class="comment"><a href="/u1069002">u1069002</a> commented</div>
    <div class="body"><p>Thanks @u1069002!</p></div>
    <div class="sidebar"><span>Reviewers</span><span>u1069002</span></div>
  `);
  assert.equal(replacedSpans(window).length, 4);
});

test('does nothing when disabled', () => {
  const window = setup('<p id="t">opened by u1069002</p>', { enabled: false });
  assert.equal($(window, '#t').textContent, 'opened by u1069002');
});

test('does nothing when there are no mappings', () => {
  const window = setup('<p id="t">opened by u1069002</p>', { mappings: {} });
  assert.equal($(window, '#t').textContent, 'opened by u1069002');
});

// --- idempotency and undo ---------------------------------------------------

test('scanning twice does not double-wrap', () => {
  const window = setup('<p id="t">opened by u1069002</p>');
  window.GHUN_ENGINE.scan(window.document.body);
  window.GHUN_ENGINE.scan(window.document.body);
  assert.equal(replacedSpans(window).length, 1);
  assert.equal($(window, '#t').textContent, 'opened by Obie Munoz');
});

test('restoreAll puts the original text back exactly', () => {
  const original = 'opened by u1069002 and @u1069002 replied';
  const window = setup(`<p id="t">${original}</p>`);
  assert.notEqual($(window, '#t').textContent, original);

  window.GHUN_ENGINE.restoreAll();
  assert.equal($(window, '#t').textContent, original);
  assert.equal(replacedSpans(window).length, 0);
  // Text nodes must be re-merged, or a later scan sees fragments.
  assert.equal($(window, '#t').childNodes.length, 1);
});

test('changing settings re-renders without a reload', () => {
  const window = setup('<p id="t">opened by u1069002</p>');
  assert.equal($(window, '#t').textContent, 'opened by Obie Munoz');

  window.GHUN_ENGINE.applySettings({ enabled: true, mappings: { u1069002: 'O. Munoz' } });
  assert.equal($(window, '#t').textContent, 'opened by O. Munoz');

  window.GHUN_ENGINE.applySettings({ enabled: false, mappings: MAPPINGS });
  assert.equal($(window, '#t').textContent, 'opened by u1069002');
});

// --- live DOM updates -------------------------------------------------------

test('replaces content added after load, the way GitHub does', async () => {
  const chromeStub = () => ({
    runtime: { id: 'test-extension', lastError: null },
    storage: {
      sync: { get: (key, cb) => cb({ [key]: { enabled: true, mappings: MAPPINGS } }) },
      onChanged: { addListener() {} },
    },
  });

  const window = setup('<div id="thread"></div>', { chromeStub });

  // Existing content is handled on start.
  assert.equal(replacedSpans(window).length, 0);

  // Simulate an async comment / hovercard being injected.
  const comment = window.document.createElement('div');
  comment.innerHTML = '<a href="/u1069002">u1069002</a> commented';
  $(window, '#thread').appendChild(comment);

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(replacedSpans(window).length, 1);
  assert.equal(comment.textContent, 'Obie Munoz commented');
});

test('does not loop forever on its own mutations', async () => {
  const chromeStub = () => ({
    runtime: { id: 'test-extension', lastError: null },
    storage: {
      sync: { get: (key, cb) => cb({ [key]: { enabled: true, mappings: MAPPINGS } }) },
      onChanged: { addListener() {} },
    },
  });

  const window = setup('<p id="t">opened by u1069002</p>', { chromeStub });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(replacedSpans(window).length, 1);
  assert.equal($(window, '#t').textContent, 'opened by Obie Munoz');
});
