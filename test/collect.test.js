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
  '<!doctype html><html><head><meta name="hovercard-subject-tag" content="user:583231"></head>' +
  '<body><h1 class="vcard-names">' +
  `<span class="p-name vcard-fullname" itemprop="name">${name}</span>` +
  '<span class="p-nickname vcard-username" itemprop="additionalName">someone</span></h1></body></html>';

const orgPage = (name) =>
  '<!doctype html><html><head><meta name="hovercard-subject-tag" content="organization:9919"></head>' +
  `<body><h1 class="h2 lh-condensed" itemprop="name">${name}</h1></body></html>`;

const otherPage = '<!doctype html><html><body><h1 itemprop="name">Your feed</h1></body></html>';

function setup(
  bodyHtml,
  { names = {}, orgs = {}, pages = [], mappings = {}, url = 'https://github.com/pulls' } = {}
) {
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
    if (login in names) return { ok: true, status: 200, text: async () => profilePage(names[login]) };
    if (login in orgs) return { ok: true, status: 200, text: async () => orgPage(orgs[login]) };
    if (pages.includes(login)) return { ok: true, status: 200, text: async () => otherPage };
    return { ok: false, status: 404, text: async () => '' };
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

test('finds the people a pull request list links to by author filter', () => {
  const { window, collect } = setup(
    '<a href="/pingdotgg/t3code/pulls?q=is%3Apr+author%3Ajuliusmarminge">juliusmarminge</a>' +
      '<a href="/pingdotgg/t3code/issues?q=is:issue assignee:esthor">esthor</a>' +
      '<a href="https://github.com/pulls?q=review-requested%3Abmdavis419">bmdavis419</a>' +
      '<a href="/pingdotgg/t3code/pulls?q=author%3Aapp%2Fdependabot">bot</a>' +
      '<a href="/pingdotgg/t3code/pulls?q=author%3A%40me">me</a>' +
      '<a href="https://elsewhere.example.com/pulls?q=author%3Aoctocat">offsite</a>'
  );

  assert.deepEqual(plain(collect.collectUsernames(window.document.body)), [
    'juliusmarminge',
    'esthor',
    'bmdavis419',
  ]);
});

test('finds the people whose avatars are on the page', () => {
  const { window, collect } = setup(
    '<img class="avatar" src="https://avatars.githubusercontent.com/u/51714798?v=4" alt="@juliusmarminge">' +
      '<img src="https://avatars.githubusercontent.com/u/1?s=40" alt="esthor">' +
      '<img src="/images/logo.png" alt="@octocat">'
  );

  assert.deepEqual(plain(collect.collectUsernames(window.document.body)), ['juliusmarminge', 'esthor']);
});

test('skips GitHub’s own header, navigation menus and footer', () => {
  const { window, collect } = setup(
    '<header class="AppHeader" role="banner"><a href="/claude">Claude</a>' +
      '<img src="https://avatars.githubusercontent.com/u/2" alt="@me"></header>' +
      '<div role="navigation"><a href="/someone">menu</a></div>' +
      '<footer><a href="/hubot">hubot</a></footer>' +
      '<a href="/octocat">octocat</a>'
  );

  assert.deepEqual(plain(collect.collectUsernames(window.document.body)), ['octocat']);
});

test('skips GitHub’s own top-level pages', () => {
  const { window, collect } = setup('<a href="/repos">repos</a> <a href="/feed">feed</a>');

  assert.deepEqual(plain(collect.collectUsernames(window.document.body)), []);
});

test('reads the profile name from a profile page', () => {
  const { collect } = setup('');

  assert.deepEqual(plain(collect.profileFromHtml(profilePage('Obie Munoz'), 'u1069002')), { name: 'Obie Munoz' });
  assert.deepEqual(plain(collect.profileFromHtml(profilePage('  Obie\n  Munoz '), 'u1069002')), {
    name: 'Obie Munoz',
  });
});

test('falls back to the schema.org name when the microformat class is gone', () => {
  const { collect } = setup('');
  const html =
    '<meta name="hovercard-subject-tag" content="user:1"><span itemprop="name">Obie Munoz</span>';

  assert.deepEqual(plain(collect.profileFromHtml(html, 'u1069002')), { name: 'Obie Munoz' });
});

test('recognizes a profile by its username markup alone', () => {
  const { collect } = setup('');
  const html = '<span itemprop="name">Obie Munoz</span><span itemprop="additionalName">u1069002</span>';

  assert.deepEqual(plain(collect.profileFromHtml(html, 'u1069002')), { name: 'Obie Munoz' });
});

test('reads no name from a profile that only repeats the login, or has none', () => {
  const { collect } = setup('');

  assert.deepEqual(plain(collect.profileFromHtml(profilePage('u1069002'), 'u1069002')), { name: '' });
  assert.deepEqual(plain(collect.profileFromHtml(profilePage(''), 'u1069002')), { name: '' });
});

test('reads no profile from an organization or any other page', () => {
  const { collect } = setup('');

  assert.equal(collect.profileFromHtml(orgPage('Ping Labs'), 'pingdotgg'), null);
  assert.equal(collect.profileFromHtml(otherPage, 'feed'), null);
  assert.equal(collect.profileFromHtml('<p>no profile here</p>', 'u1069002'), null);
});

test('collects each person with the name on their profile', async () => {
  const { collect } = setup('<a href="/octocat">octocat</a> <a href="/hubot">hubot</a>', {
    names: { octocat: 'The Octocat', hubot: '' },
  });

  assert.deepEqual(plain(await collect.collectPeople()), {
    people: [
      { username: 'octocat', name: 'The Octocat' },
      { username: 'hubot', name: '' },
    ],
    truncated: false,
  });
});

test('leaves out organizations and pages that are not a person', async () => {
  const { collect } = setup(
    '<a href="/octocat">octocat</a> <a href="/pingdotgg">pingdotgg</a> <a href="/claude">claude</a>' +
      '<a href="/ghost">ghost</a>',
    { names: { octocat: 'The Octocat' }, orgs: { pingdotgg: 'Ping Labs' }, pages: ['claude'] }
  );

  assert.deepEqual(plain(await collect.collectPeople()), {
    people: [{ username: 'octocat', name: 'The Octocat' }],
    truncated: false,
  });
});

test('keeps someone GitHub itself marks as a user even when their profile can’t be read', async () => {
  const { collect } = setup('<span data-hovercard-url="/users/hubot/hovercard">avatar</span>');

  assert.deepEqual(plain(await collect.collectPeople()), {
    people: [{ username: 'hubot', name: '' }],
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
  const names = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [`user-${i}`, '']));
  const { collect, fetched } = setup(links, { names });

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
