'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/common.js');
const {
  buildMatcher,
  usernameFromUrl,
  isRepoRootPath,
  usernameFromHovercardUrl,
  parseImport,
  coerceSettings,
  looksLikeUrl,
} = globalThis.GHUN;

/** Run the matcher the way content.js does and return the matched tokens. */
function matches(mappings, text) {
  const matcher = buildMatcher(mappings);
  if (!matcher) return [];
  return Array.from(text.matchAll(matcher)).map((m) => m[0]);
}

const OBIE = { u1069002: 'Obie Munoz' };

test('buildMatcher returns null with no mappings', () => {
  assert.equal(buildMatcher({}), null);
  assert.equal(buildMatcher(null), null);
});

test('matches a standalone username', () => {
  assert.deepEqual(matches(OBIE, 'opened by u1069002 3 hours ago'), ['u1069002']);
});

test('keeps the @ on a mention', () => {
  assert.deepEqual(matches(OBIE, 'cc @u1069002 please'), ['@u1069002']);
});

test('is case-insensitive', () => {
  assert.deepEqual(matches(OBIE, 'U1069002 approved'), ['U1069002']);
});

test('does not match a longer username that starts the same', () => {
  assert.deepEqual(matches(OBIE, 'u10690021 opened this'), []);
  assert.deepEqual(matches(OBIE, 'u1069002-bot opened this'), []);
  assert.deepEqual(matches(OBIE, 'u1069002_old opened this'), []);
});

test('does not match a username embedded in a longer word', () => {
  assert.deepEqual(matches(OBIE, 'xu1069002'), []);
  assert.deepEqual(matches(OBIE, 'team-u1069002'), []);
});

test('does not match inside an email address', () => {
  assert.deepEqual(matches(OBIE, 'from foo@u1069002.example.com today'), []);
});

test('does not match a username inside a domain name', () => {
  // A repo or site named after its owner: obiemunoz.com must stay literal.
  const mappings = { obiemunoz: 'Obie Munoz' };
  assert.deepEqual(matches(mappings, 'obiemunoz.com'), []);
  assert.deepEqual(matches(mappings, 'the obiemunoz.com repo'), []);
  assert.deepEqual(matches(mappings, 'obiemunoz.dev and obiemunoz.io'), []);
});

test('still matches a username ending a sentence', () => {
  // The trailing dot is punctuation here, not a domain.
  const mappings = { obiemunoz: 'Obie Munoz' };
  assert.deepEqual(matches(mappings, 'shipped by obiemunoz.'), ['obiemunoz']);
  assert.deepEqual(matches(mappings, 'thanks obiemunoz. Next up…'), ['obiemunoz']);
  assert.deepEqual(matches(mappings, 'ask obiemunoz, then merge'), ['obiemunoz']);
});

test('does not match a path segment', () => {
  assert.deepEqual(matches(OBIE, 'see /u1069002 for details'), []);
});

test('handles hyphenated usernames on their boundaries', () => {
  const mappings = { 'some-user': 'Real Person' };
  assert.deepEqual(matches(mappings, 'some-user pushed'), ['some-user']);
  assert.deepEqual(matches(mappings, 'some-user-2 pushed'), []);
});

test('prefers the longest username when one is a prefix of another', () => {
  const mappings = { bob: 'Bob One', bobby: 'Bob Two' };
  assert.deepEqual(matches(mappings, 'bobby and bob'), ['bobby', 'bob']);
});

test('finds every occurrence in one string', () => {
  const mappings = { u1069002: 'Obie Munoz', octocat: 'The Octocat' };
  assert.deepEqual(
    matches(mappings, 'u1069002 reviewed octocat and @u1069002 replied'),
    ['u1069002', 'octocat', '@u1069002']
  );
});

test('escapes regex metacharacters in stored keys', () => {
  // Not a valid username, but the matcher must never build a broken regex.
  assert.doesNotThrow(() => buildMatcher({ 'a.c': 'x', 'b+d': 'y' }));
});

test('looksLikeUrl flags text where a rewrite would misrepresent a link', () => {
  assert.equal(looksLikeUrl('https://github.com/u1069002'), true);
  assert.equal(looksLikeUrl('github.com/u1069002/repo'), true);
  assert.equal(looksLikeUrl('opened by u1069002'), false);
});

test('usernameFromUrl accepts profile links only', () => {
  assert.equal(usernameFromUrl('https://github.com/u1069002'), 'u1069002');
  assert.equal(usernameFromUrl('https://github.com/u1069002?tab=repositories'), 'u1069002');
  assert.equal(usernameFromUrl('/u1069002'), 'u1069002');
  assert.equal(usernameFromUrl('https://github.com/owner/repo'), null);
  assert.equal(usernameFromUrl('https://github.com/settings'), null);
  assert.equal(usernameFromUrl('https://github.com/pricing'), null);
  assert.equal(usernameFromUrl('https://evil.example.com/u1069002'), null);
  assert.equal(usernameFromUrl('not a url at all'), null);
});

test('isRepoRootPath identifies repo home links only', () => {
  assert.equal(isRepoRootPath('/ObieMunoz/obiemunoz.com'), true);
  assert.equal(isRepoRootPath('https://github.com/ObieMunoz/obiemunoz.com'), true);
  // A profile link must stay replaceable.
  assert.equal(isRepoRootPath('/ObieMunoz'), false);
  // Deeper paths are page titles that may legitimately mention someone.
  assert.equal(isRepoRootPath('/ObieMunoz/obiemunoz.com/pull/12'), false);
  assert.equal(isRepoRootPath('/orgs/github'), false);
  assert.equal(isRepoRootPath('https://evil.example.com/a/b'), false);
});

test('usernameFromHovercardUrl reads GitHub user hovercard endpoints', () => {
  assert.equal(usernameFromHovercardUrl('/users/u1069002/hovercard'), 'u1069002');
  assert.equal(usernameFromHovercardUrl('/users/mona-lisa/hovercard?subject_id=1'), 'mona-lisa');
});

test('usernameFromHovercardUrl ignores organizations and junk', () => {
  // An org row must not inherit the previously hovered user.
  assert.equal(usernameFromHovercardUrl('/orgs/github/hovercard'), null);
  assert.equal(usernameFromHovercardUrl('/users/not a username!/hovercard'), null);
  assert.equal(usernameFromHovercardUrl(''), null);
  assert.equal(usernameFromHovercardUrl(null), null);
});

test('coerceSettings drops malformed entries and defaults enabled to true', () => {
  const result = coerceSettings({
    mappings: { U1069002: '  Obie Munoz  ', bad: '', 'not a username!': 'X', ok: 5 },
  });
  assert.deepEqual(result.mappings, { u1069002: 'Obie Munoz' });
  assert.equal(result.enabled, true);
});

test('coerceSettings survives junk input', () => {
  assert.deepEqual(coerceSettings(undefined), { enabled: true, mappings: {} });
  assert.deepEqual(coerceSettings('nope'), { enabled: true, mappings: {} });
  assert.equal(coerceSettings({ enabled: false }).enabled, false);
});

test('parseImport reads the wrapped export format', () => {
  const json = JSON.stringify({ version: 1, enabled: false, mappings: { u1069002: 'Obie Munoz' } });
  const result = parseImport(json);
  assert.deepEqual(result.mappings, { u1069002: 'Obie Munoz' });
  assert.equal(result.enabled, false);
});

test('parseImport also reads a bare username map', () => {
  const result = parseImport('{"u1069002":"Obie Munoz"}');
  assert.deepEqual(result.mappings, { u1069002: 'Obie Munoz' });
  assert.equal(result.enabled, undefined);
});

test('parseImport rejects unusable files with a readable message', () => {
  assert.throws(() => parseImport('{nope'), /valid JSON/);
  assert.throws(() => parseImport('[1,2,3]'), /JSON object/);
  assert.throws(() => parseImport('{"!!!":"x"}'), /No usable username mappings/);
});
