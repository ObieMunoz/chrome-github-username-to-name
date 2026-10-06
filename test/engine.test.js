'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const COMMON_SRC = fs.readFileSync(path.join(__dirname, '../src/common.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(__dirname, '../src/store.js'), 'utf8');
const CONTENT_SRC = fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8');

const MAPPINGS = { u1069002: 'Obie Munoz' };

/**
 * Build a page, load the real content script into it, and run one scan.
 * `chromeStub` is omitted by default so the script does not self-start.
 */
function setup(
  bodyHtml,
  { mappings = MAPPINGS, enabled = true, chromeStub = null, url = 'https://github.com/' } = {}
) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
    url,
  });
  const { window } = dom;

  window.eval(COMMON_SRC);
  window.eval(STORE_SRC);
  if (chromeStub) window.chrome = chromeStub(window);
  window.eval(CONTENT_SRC);

  if (!chromeStub) {
    window.GHUN_ENGINE.applySettings({ enabled, mappings }, { rescan: false });
    window.GHUN_ENGINE.scan(window.document.body);
  }
  return window;
}

/**
 * A chrome stand-in backed by real stored items, for tests that drive `start`.
 * `write` stores items and fires storage.onChanged the way Chrome does.
 */
function storageStub(initial) {
  const items = { ...initial };
  const listeners = [];
  const messages = [];

  const factory = () => ({
    runtime: {
      id: 'test-extension',
      lastError: null,
      sendMessage: async (message) => {
        messages.push(message);
      },
    },
    storage: {
      sync: { get: async () => JSON.parse(JSON.stringify(items)) },
      onChanged: { addListener: (listener) => listeners.push(listener) },
    },
  });

  factory.messages = messages;
  factory.write = (next) => {
    const changes = {};
    for (const [key, value] of Object.entries(next)) {
      changes[key] = { oldValue: items[key], newValue: value };
      items[key] = value;
    }
    for (const listener of listeners) listener(changes, 'sync');
  };
  return factory;
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const $ = (window, selector) => window.document.querySelector(selector);
const replacedSpans = (window) => window.document.querySelectorAll('span.ghun-name');

/**
 * What the page reads as — which is deliberately not what its text says.
 *
 * A replacement is drawn by content.css as generated content from
 * `data-ghun-shown`, and the span's own text stays the original username. So
 * `textContent` is the assertion for what a copy, a quote reply, or GitHub's
 * own scripts come away with, and this is the assertion for what a person sees.
 * jsdom applies no stylesheets, so the name is reassembled here the same way
 * the cascade would.
 *
 * @param {string|Element} target a selector, or the element itself.
 */
function shown(window, target) {
  const root = typeof target === 'string' ? $(window, target) : target;
  const { TEXT_NODE, ELEMENT_NODE } = window.Node;

  const read = (el) => {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === TEXT_NODE) text += node.nodeValue;
      else if (node.nodeType !== ELEMENT_NODE) continue;
      else if (node.classList.contains('ghun-name')) text += node.getAttribute('data-ghun-shown');
      else text += read(node);
    }
    return text;
  };
  return read(root);
}

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
  assert.equal(shown(window, '#t'), 'reviewed by Obie Munoz');
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
  const chromeStub = storageStub({ ghun: { enabled: true, mappings: MAPPINGS } });

  const window = setup(
    '<div class="react-code-file-contents"><div id="lines" class="react-code-lines"></div></div>',
    { chromeStub }
  );
  await settle();

  const source = 'git blame --author=u1069002';
  const line = window.document.createElement('div');
  line.innerHTML = codeLine(source, 42);
  $(window, '#lines').appendChild(line);

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal($(window, '#LC42').textContent, source);
  assert.equal(replacedSpans(window).length, 0);
});

test('never rewrites the styled copy laid over the pull request filter bar', () => {
  const query = 'is:pr state:open author:u1069002';
  const window = setup(
    '<div class="FilterBar">' +
      '<input type="text" aria-label="Search all pull requests" value="' + query + '">' +
      '<div id="overlay" aria-hidden="true">' +
      '<span>is:</span><span>pr</span> <span>state:</span><span>open</span> ' +
      '<span>author:</span><span id="value">u1069002</span>' +
      '</div>' +
      '</div>'
  );

  assert.equal($(window, '#overlay').textContent, query);
  assert.equal(replacedSpans(window).length, 0);
});

test('never rewrites the styled copy beside a wrapped search input', () => {
  const query = 'author:u1069002';
  const window = setup(
    '<div class="QueryBuilder-StyledInput">' +
      '<span id="overlay" class="QueryBuilder-StyledInputContent" aria-hidden="true">' +
      '<span>author:</span><span>u1069002</span></span>' +
      '<div class="QueryBuilder-InputWrapper"><input type="search" value="' + query + '"></div>' +
      '</div>'
  );

  assert.equal($(window, '#overlay').textContent, query);
  assert.equal(replacedSpans(window).length, 0);
});

test('never rewrites a filter bar copy that React renders after load', async () => {
  const chromeStub = storageStub({ ghun: { enabled: true, mappings: MAPPINGS } });
  const window = setup(
    '<div id="bar"><input type="text" value="author:u1069002"><div id="overlay" aria-hidden="true"></div></div>',
    { chromeStub }
  );
  await settle();

  const value = window.document.createElement('span');
  value.textContent = 'u1069002';
  $(window, '#overlay').append('author:', value);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal($(window, '#overlay').textContent, 'author:u1069002');
  assert.equal(replacedSpans(window).length, 0);
});

test('still replaces hidden text that sits beside a checkbox rather than a text field', () => {
  const window = setup(
    '<div class="row"><input type="checkbox"><span id="t" aria-hidden="true">opened by u1069002</span></div>'
  );
  assert.equal(shown(window, '#t'), 'opened by Obie Munoz');
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
  assert.equal(shown(window, '#prose'), 'Stop rewriting what Obie Munoz reported');
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
  assert.equal(shown(window, '#login'), 'Obie Munoz');
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

  assert.equal(shown(window, '#owner'), 'Obie Munoz');
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
  assert.equal(shown(window, '#pr'), 'fix reported by Obie Munoz');
});

test('leaves the profile link href untouched', () => {
  const window = setup('<a id="a" href="/u1069002" class="author">u1069002</a>');
  const link = $(window, '#a');
  assert.equal(link.getAttribute('href'), '/u1069002');
  assert.equal(shown(window, link), 'Obie Munoz');
  assert.equal(link.querySelector('span.ghun-name').getAttribute('data-ghun-user'), 'u1069002');
});

// --- replacement behaviour --------------------------------------------------

test('replaces a bare username and keeps surrounding text', () => {
  const window = setup('<p id="t">opened by u1069002 3 hours ago</p>');
  assert.equal(shown(window, '#t'), 'opened by Obie Munoz 3 hours ago');
});

test('keeps the @ on a mention', () => {
  const window = setup('<p id="t">cc @u1069002 for review</p>');
  assert.equal(shown(window, '#t'), 'cc @Obie Munoz for review');
});

test('exposes the original username as a tooltip', () => {
  const window = setup('<p>cc @u1069002</p>');
  const span = replacedSpans(window)[0];
  assert.equal(span.getAttribute('title'), '@u1069002');
  assert.equal(span.getAttribute('data-ghun-raw'), '@u1069002');
  assert.equal(span.getAttribute('data-ghun-user'), 'u1069002');
  assert.equal(span.getAttribute('data-ghun-shown'), '@Obie Munoz');
});

// --- what the page says, as opposed to what it reads as ---------------------
//
// GitHub's "Quote reply" builds its markdown out of the comment's own DOM, so
// the name has to stay out of the DOM's text or it ends up submitted. The bug
// this guards against: quoting a comment that mentioned "@ObieMunoz" pasted
// "@Obie Munoz (Foot Locker)" into the reply box, and GitHub read the first
// word of that as a mention of @Obie — a real account with no part in the
// thread.

test('leaves the original username as the only text in the page', () => {
  const window = setup('<p id="t">cc @u1069002 for review</p>');

  // What a quote, a copy, or any other reader of page text comes away with.
  assert.equal($(window, '#t').textContent, 'cc @u1069002 for review');
  // What the reader of the page sees.
  assert.equal(shown(window, '#t'), 'cc @Obie Munoz for review');
});

test('keeps a whole comment body quotable verbatim', () => {
  // The comment from the report, in GitHub's own markup.
  const body =
    '<p><a class="user-mention" href="/u1069002">@u1069002</a> ' +
    "it's only conditionally included in a certain <em>type</em> of response.</p>";
  const window = setup(`<div id="c" class="comment-body">${body}</div>`);

  assert.equal(
    $(window, '#c').textContent,
    "@u1069002 it's only conditionally included in a certain type of response."
  );
  assert.equal(
    shown(window, '#c'),
    "@Obie Munoz it's only conditionally included in a certain type of response."
  );
});

test('carries the name on an element a screen reader will read once', () => {
  const window = setup('<p>cc @u1069002</p>');
  const span = replacedSpans(window)[0];
  const source = span.querySelector('span.ghun-source');

  // The name is announced from the generated content; the username underneath
  // it is for the machines, so it is hidden from assistive technology.
  assert.equal(source.textContent, '@u1069002');
  assert.equal(source.getAttribute('aria-hidden'), 'true');
  assert.equal(span.children.length, 1);
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
  assert.equal(shown(window, '#t'), 'opened by u1069002');
  assert.equal(replacedSpans(window).length, 0);
});

test('does nothing when there are no mappings', () => {
  const window = setup('<p id="t">opened by u1069002</p>', { mappings: {} });
  assert.equal(shown(window, '#t'), 'opened by u1069002');
  assert.equal(replacedSpans(window).length, 0);
});

// --- idempotency and undo ---------------------------------------------------

test('scanning twice does not double-wrap', () => {
  const window = setup('<p id="t">opened by u1069002</p>');
  window.GHUN_ENGINE.scan(window.document.body);
  window.GHUN_ENGINE.scan(window.document.body);
  assert.equal(replacedSpans(window).length, 1);
  assert.equal(shown(window, '#t'), 'opened by Obie Munoz');
});

test('restoreAll puts the original text back exactly', () => {
  const original = 'opened by u1069002 and @u1069002 replied';
  const window = setup(`<p id="t">${original}</p>`);
  assert.equal(replacedSpans(window).length, 2);
  assert.notEqual(shown(window, '#t'), original);

  window.GHUN_ENGINE.restoreAll();
  assert.equal($(window, '#t').textContent, original);
  assert.equal(replacedSpans(window).length, 0);
  // Text nodes must be re-merged, or a later scan sees fragments.
  assert.equal($(window, '#t').childNodes.length, 1);
});

test('changing settings re-renders without a reload', () => {
  const window = setup('<p id="t">opened by u1069002</p>');
  assert.equal(shown(window, '#t'), 'opened by Obie Munoz');

  window.GHUN_ENGINE.applySettings({ enabled: true, mappings: { u1069002: 'O. Munoz' } });
  assert.equal(shown(window, '#t'), 'opened by O. Munoz');

  window.GHUN_ENGINE.applySettings({ enabled: false, mappings: MAPPINGS });
  assert.equal(shown(window, '#t'), 'opened by u1069002');
  assert.equal(replacedSpans(window).length, 0);
});

// --- live DOM updates -------------------------------------------------------

test('replaces content added after load, the way GitHub does', async () => {
  const chromeStub = storageStub({ ghun: { enabled: true, mappings: MAPPINGS } });

  const window = setup('<div id="thread"></div>', { chromeStub });
  await settle();

  // Existing content is handled on start.
  assert.equal(replacedSpans(window).length, 0);

  // Simulate an async comment / hovercard being injected.
  const comment = window.document.createElement('div');
  comment.innerHTML = '<a href="/u1069002">u1069002</a> commented';
  $(window, '#thread').appendChild(comment);

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(replacedSpans(window).length, 1);
  assert.equal(shown(window, comment), 'Obie Munoz commented');
});

test('does not loop forever on its own mutations', async () => {
  const chromeStub = storageStub({ ghun: { enabled: true, mappings: MAPPINGS } });

  const window = setup('<p id="t">opened by u1069002</p>', { chromeStub });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(replacedSpans(window).length, 1);
  assert.equal(shown(window, '#t'), 'opened by Obie Munoz');
});

// --- GitHub Enterprise -------------------------------------------------------

test('skips a repo home page link on an Enterprise host', () => {
  const window = setup('<a id="r" href="https://github.example.com/u1069002/u1069002">u1069002</a>', {
    url: 'https://github.example.com/',
  });
  assert.equal(shown(window, '#r'), 'u1069002');
});

test('leaves a bare Enterprise URL in text alone', () => {
  const window = setup('<p id="t">see github.example.com/u1069002</p>', {
    url: 'https://github.example.com/',
  });
  assert.equal(shown(window, '#t'), 'see github.example.com/u1069002');
});

test('still replaces names on an Enterprise host', () => {
  const window = setup('<p id="t">opened by u1069002</p>', { url: 'https://github.example.com/' });
  assert.equal(shown(window, '#t'), 'opened by Obie Munoz');
});

// --- storage ----------------------------------------------------------------

test('reads mappings saved across several storage chunks', async () => {
  const chromeStub = storageStub({
    ghun: { enabled: true, color: null, chunks: 2 },
    'ghun.m.0': { u1069002: 'Obie Munoz' },
    'ghun.m.1': { octocat: 'The Octocat' },
  });
  const window = setup('<p id="t">u1069002 and octocat</p>', { chromeStub });
  await settle();

  assert.equal(shown(window, '#t'), 'Obie Munoz and The Octocat');
});

test('repaints when a save changes only a chunk', async () => {
  const chromeStub = storageStub({
    ghun: { enabled: true, color: null, chunks: 1 },
    'ghun.m.0': { u1069002: 'Obie Munoz' },
  });
  const window = setup('<p id="t">u1069002 and octocat</p>', { chromeStub });
  await settle();

  chromeStub.write({ 'ghun.m.0': { u1069002: 'Obie Munoz', octocat: 'The Octocat' } });
  await settle();

  assert.equal(shown(window, '#t'), 'Obie Munoz and The Octocat');
});

test('ignores storage changes that are not its own', async () => {
  const chromeStub = storageStub({ ghun: { enabled: true, mappings: MAPPINGS } });
  const window = setup('<p id="t">opened by u1069002</p>', { chromeStub });
  await settle();
  const span = $(window, 'span.ghun-name');

  chromeStub.write({ unrelated: 1 });
  await settle();

  assert.equal($(window, 'span.ghun-name'), span);
});

// --- highlight color --------------------------------------------------------

/**
 * The color is published to `<html>`, outside anything a scan touches, and only
 * on start — so these drive the real `start` rather than calling applySettings.
 */
async function started(stored) {
  const window = setup('<p id="t">opened by u1069002</p>', {
    chromeStub: storageStub({ ghun: stored }),
  });
  await settle();
  return window;
}

const inlineColor = (window) =>
  window.document.documentElement.style.getPropertyValue('--ghun-color');

/** A layout variable of GitHub's own, to stand in for whatever it writes. */
const PAGE_STYLE = '--sticky-pane-height: 100px;';

test('puts the highlight color back when the page clears it', async () => {
  // Navigating back to a page GitHub has already rendered brings it back with
  // <html>'s inline style gone. Every name on it then read as the shipped
  // default, and only a reload — a fresh document — put the pick back.
  const window = await started({ enabled: true, mappings: MAPPINGS, color: '#ff00ff' });
  assert.equal(inlineColor(window), '#ff00ff');

  window.document.documentElement.removeAttribute('style');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(inlineColor(window), '#ff00ff');
});

test('puts it back without taking the page style with it', async () => {
  const window = await started({ enabled: true, mappings: MAPPINGS, color: '#ff00ff' });
  const root = window.document.documentElement;

  root.setAttribute('style', PAGE_STYLE);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(inlineColor(window), '#ff00ff');
  assert.equal(root.style.getPropertyValue('--sticky-pane-height'), '100px');
});

test('writes no color at all while on the default', async () => {
  const window = await started({ enabled: true, mappings: MAPPINGS });
  const root = window.document.documentElement;
  assert.equal(inlineColor(window), '');

  root.setAttribute('style', PAGE_STYLE);
  await new Promise((resolve) => setTimeout(resolve, 10));

  // content.css owns the theme-aware default, so watching must not turn into
  // writing one back: any inline value here would outrank the whole cascade.
  assert.equal(inlineColor(window), '');
});

test('does not trade writes with the page over the color', async () => {
  const window = await started({ enabled: true, mappings: MAPPINGS, color: '#ff00ff' });
  const root = window.document.documentElement;

  let writes = 0;
  const spy = new window.MutationObserver((records) => {
    writes += records.length;
  });
  spy.observe(root, { attributes: true, attributeFilter: ['style'] });

  root.removeAttribute('style');
  await new Promise((resolve) => setTimeout(resolve, 30));
  spy.disconnect();

  // The page's clear, then one write to put the color back. Re-writing a value
  // already there would mutate the attribute again and restart the cycle.
  assert.equal(writes, 2);
  assert.equal(inlineColor(window), '#ff00ff');
});

test('re-applies the color on a soft navigation', async () => {
  const window = await started({ enabled: true, mappings: MAPPINGS, color: '#ff00ff' });

  // With the observers stopped, the navigation hook is the only path left —
  // which is the case where the element being watched is no longer the live one.
  window.GHUN_ENGINE.shutdown();
  window.document.documentElement.removeAttribute('style');
  window.document.dispatchEvent(new window.Event('turbo:load'));

  assert.equal(inlineColor(window), '#ff00ff');
});
