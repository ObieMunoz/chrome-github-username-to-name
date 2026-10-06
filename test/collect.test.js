'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
const COMMON_SRC = read('common.js');
const COLLECT_SRC = read('collect.js');

const profilePage = (name) =>
  '<!doctype html><html><body><h1 class="vcard-names">' +
  `<span class="p-name vcard-fullname" itemprop="name">${name}</span>` +
  '<span class="p-nickname vcard-username">someone</span></h1></body></html>';

function setup(bodyHtml, { names = {}, mappings = {}, url = 'https://github.com/pulls' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
    url,
  });
  const { window } = dom;
  const fetched = [];

  window.fetch = async (resource) => {
    const target = new URL(String(resource), window.location.href);
    fetched.push(target.href);
    const login = target.pathname.slice(1).toLowerCase();
    if (!(login in names)) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => profilePage(names[login]) };
  };
  window.GHUN_ENGINE = { getSettings: () => ({ enabled: true, mappings, color: null }) };

  window.eval(COMMON_SRC);
  window.eval(COLLECT_SRC);
  return { window, fetched, collect: window.GHUN_COLLECT };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('finds the people linked from the page, once each, in page order', () => {
  const { window, collect } = setup(
    '<a href="/octocat">octocat</a> <a href="/hubot">hubot</a> <a href="/OctoCat">again</a>' +
      '<span data-hovercard-url="/users/u1069002/hovercard">avatar</span>'
  );

  assert.deepEqual(plain(collect.collectUsernames(window.document.body)), ['octocat', 'hubot', 'u1069002']);
});

test('skips repos, reserved pages, organizations and its own UI', () => {
  const { window, collect } = setup(
    '<a href="/octocat/hello">repo</a> <a href="/settings">settings</a>' +
      '<span data-hovercard-url="/orgs/github/hovercard">org</span>' +
      '<div data-ghun-ui><a href="/hubot">hubot</a></div>'
  );

  assert.deepEqual(plain(collect.collectUsernames(window.document.body)), []);
});

test('skips people who already have a name', () => {
  const { window, collect } = setup('<a href="/octocat">octocat</a> <a href="/hubot">hubot</a>', {
    mappings: { octocat: 'The Octocat' },
  });

  assert.deepEqual(plain(collect.collectUsernames(window.document.body)), ['hubot']);
});

test('reads the profile name from a profile page', () => {
  const { collect } = setup('');

  assert.equal(collect.profileNameFromHtml(profilePage('Obie Munoz'), 'u1069002'), 'Obie Munoz');
  assert.equal(collect.profileNameFromHtml(profilePage('  Obie\n  Munoz '), 'u1069002'), 'Obie Munoz');
});

test('falls back to the schema.org name when the microformat class is gone', () => {
  const { collect } = setup('');
  const html = '<meta itemprop="image" content="x"><span itemprop="name">Obie Munoz</span>';

  assert.equal(collect.profileNameFromHtml(html, 'u1069002'), 'Obie Munoz');
});

test('reads no name from a profile that only repeats the login, or has none', () => {
  const { collect } = setup('');

  assert.equal(collect.profileNameFromHtml(profilePage('u1069002'), 'u1069002'), '');
  assert.equal(collect.profileNameFromHtml(profilePage(''), 'u1069002'), '');
  assert.equal(collect.profileNameFromHtml('<p>no profile here</p>', 'u1069002'), '');
});

test('collects each person with the name on their profile', async () => {
  const { collect } = setup('<a href="/octocat">octocat</a> <a href="/hubot">hubot</a>', {
    names: { octocat: 'The Octocat' },
  });

  assert.deepEqual(plain(await collect.collectPeople()), {
    people: [
      { username: 'octocat', name: 'The Octocat' },
      { username: 'hubot', name: '' },
    ],
    truncated: false,
  });
});

test('fetches profiles from the page’s own host', async () => {
  const { collect, fetched } = setup('<a href="/octocat">octocat</a>', {
    url: 'https://github.example.com/pulls',
  });

  await collect.collectPeople();

  assert.deepEqual(fetched, ['https://github.example.com/octocat']);
});

test('treats a failed fetch as a profile with no name', async () => {
  const { window, collect } = setup('<a href="/octocat">octocat</a>');
  window.fetch = async () => {
    throw new Error('offline');
  };

  assert.deepEqual(plain(await collect.collectPeople()), {
    people: [{ username: 'octocat', name: '' }],
    truncated: false,
  });
});

test('caps how many profiles one collection fetches', async () => {
  const links = Array.from({ length: 130 }, (_, i) => `<a href="/user-${i}">u</a>`).join(' ');
  const { collect, fetched } = setup(links);

  const result = await collect.collectPeople();

  assert.equal(result.people.length, collect.MAX_PEOPLE);
  assert.equal(fetched.length, collect.MAX_PEOPLE);
  assert.equal(result.truncated, true);
});

test('never has more than a few profile requests in flight', async () => {
  const links = Array.from({ length: 20 }, (_, i) => `<a href="/user-${i}">u</a>`).join(' ');
  const { window, collect } = setup(links);
  let inFlight = 0;
  let peak = 0;
  window.fetch = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return { ok: false, status: 404, text: async () => '' };
  };

  await collect.collectPeople();

  assert.ok(peak <= collect.CONCURRENCY, `peak was ${peak}`);
  assert.ok(peak > 1);
});
