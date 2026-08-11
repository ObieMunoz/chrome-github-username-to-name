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

/**
 * One source line as GitHub's file and blame views actually build it: a plain
 * `div` per line, with no `code` or `pre` anywhere in the chain.
 */
function codeLine(text, lineNumber = 1) {
  return (
    '<div class="react-code-text react-code-line-contents"><div>' +
    `<div id="LC${lineNumber}" class="react-file-line html-div" ` +
    `data-testid="code-cell" data-line-number="${lineNumber}">${text}</div>` +
    '</div></div>'
  );
}

test('never rewrites the file view, which marks up no code element', () => {
  // Viewing a file used to rewrite usernames in the source itself, because the
  // CODE/PRE rule has nothing to fire on here.
  const source = "const MAPPINGS = { u1069002: 'Obie Munoz' };";
  const window = setup(
    '<div class="react-code-file-contents"><div class="react-code-lines">' +
      codeLine(source) +
      '</div></div>'
  );

  assert.equal($(window, '#LC1').textContent, source);
  assert.equal(replacedSpans(window).length, 0);
});

test('never rewrites the blame view, which drops the file-contents wrapper', () => {
  // Blame nests the same line inside its own hashed wrappers, so the line's own
  // classes — not the file-view container — have to be what stops the walk.
  const source = 'Fork me? Fork you, @u1069002!';
  const window = setup(`<div class="Blame-module__codeLine__fhKEj">${codeLine(source, 16)}</div>`);

  assert.equal($(window, '#LC16').textContent, source);
  assert.equal(replacedSpans(window).length, 0);
});

test('never rewrites code lines streamed in by the virtualized scroller', async () => {
  // The file view only renders the lines near the viewport, so most of a file
  // arrives through the observer rather than the first scan.
  const chromeStub = () => ({
    runtime: { id: 'test-extension', lastError: null },
    storage: {
      sync: { get: (key, cb) => cb({ [key]: { enabled: true, mappings: MAPPINGS } }) },
      onChanged: { addListener() {} },
    },
  });

  const window = setup(
    '<div class="react-code-file-contents"><div id="lines" class="react-code-lines"></div></div>',
    { chromeStub }
  );

  const source = 'git blame --author=u1069002';
  const line = window.document.createElement('div');
  line.innerHTML = codeLine(source, 42);
  $(window, '#lines').appendChild(line);

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal($(window, '#LC42').textContent, source);
  assert.equal(replacedSpans(window).length, 0);
});

test('never rewrites text that is a URL', () => {
  const window = setup('<p id="t">https://github.com/u1069002</p>');
  assert.equal($(window, '#t').textContent, 'https://github.com/u1069002');
});

test('leaves the author email on the merge screen intact', () => {
  // The real "Confirm merge" line, where the rewrite produced a nonsense
  // address: "95655512+Obie Munoz@users.noreply.github.com".
  const line = 'This commit will be authored by 95655512+obiemunoz@users.noreply.github.com';
  const window = setup(`<p id="t">${line}</p>`, { mappings: { obiemunoz: 'Obie Munoz' } });

  assert.equal($(window, '#t').textContent, line);
  assert.equal(replacedSpans(window).length, 0);
});

test('leaves the branch reference in a merge commit subject alone', () => {
  // A commit row on the repo home page, built the way GitHub builds it: the
  // subject is split across links, but "from <owner>/<branch>" lands in one
  // text node, slash and all. Rewriting the owner there breaks the ref.
  const ref = 'from obiemunoz/feature/rewrites-code-blocks-4c0b83';
  const window = setup(
    '<div class="react-directory-commit-message">' +
      '<a class="Link--secondary" href="/obiemunoz/site/commit/ffb58bd">Merge pull request</a> ' +
      '<a class="issue-link" href="/obiemunoz/site/pull/4">#4</a> ' +
      `<a id="ref" class="Link--secondary" href="/obiemunoz/site/commit/ffb58bd">${ref}</a>` +
      '</div>' +
      '<div class="react-directory-commit-message" id="prose">Stop rewriting what obiemunoz reported</div>',
    { mappings: { obiemunoz: 'Obie Munoz' } }
  );

  assert.equal($(window, '#ref').textContent, ref);
  // A commit message that genuinely names someone still reads as one.
  assert.equal($(window, '#prose').textContent, 'Stop rewriting what Obie Munoz reported');
});

test('leaves the profile sidebar handles for other services alone', () => {
  // The real sidebar rows, which GitHub marks rel="nofollow me". "@obiemunoz"
  // under the X icon names an X account, not the person the mapping is about.
  const window = setup(
    '<ul class="vcard-details">' +
      '<li class="vcard-detail" itemprop="social">' +
      '<a id="x" rel="nofollow me" href="https://x.com/obiemunoz">@obiemunoz</a></li>' +
      '<li class="vcard-detail" itemprop="social">' +
      '<a id="ig" rel="nofollow me" href="https://www.instagram.com/obiemunoz/">obiemunoz</a></li>' +
      '</ul>' +
      '<a id="login" href="/obiemunoz" class="p-nickname">obiemunoz</a>',
    { mappings: { obiemunoz: 'Obie Munoz' } }
  );

  assert.equal($(window, '#x').textContent, '@obiemunoz');
  assert.equal($(window, '#ig').textContent, 'obiemunoz');
  // The GitHub login above them is still the person.
  assert.equal($(window, '#login').textContent, 'Obie Munoz');
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
