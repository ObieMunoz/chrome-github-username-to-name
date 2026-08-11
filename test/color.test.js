'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/common.js');
const {
  DEFAULT_COLOR,
  THEME_BACKGROUNDS,
  MIN_CONTRAST,
  parseHex,
  toHex,
  normalizeHex,
  rgbToHsl,
  hslToRgb,
  contrastRatio,
  coerceColor,
  coerceSettings,
  parseImport,
} = globalThis.GHUN;

// --- parsing ---------------------------------------------------------------

test('parseHex reads every accepted spelling', () => {
  const green = { r: 57, g: 255, b: 20 };
  assert.deepEqual(parseHex('#39ff14'), green);
  assert.deepEqual(parseHex('39FF14'), green);
  assert.deepEqual(parseHex('  #39ff14  '), green);
  assert.deepEqual(parseHex('#abc'), { r: 170, g: 187, b: 204 });
});

test('parseHex rejects anything else', () => {
  for (const value of ['', '#12345', '#gggggg', 'red', null, undefined, 42, {}]) {
    assert.equal(parseHex(value), null, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('normalizeHex canonicalises, or reports failure', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex('39ff14'), '#39ff14');
  assert.equal(normalizeHex('nope'), null);
});

test('toHex clamps out-of-range channels', () => {
  assert.equal(toHex({ r: -20, g: 300, b: 128 }), '#00ff80');
});

// --- HSL round trip --------------------------------------------------------

test('rgbToHsl reads the default green', () => {
  const hsl = rgbToHsl(parseHex(DEFAULT_COLOR));
  assert.ok(Math.abs(hsl.h - 110.6) < 0.5, `hue was ${hsl.h}`);
  assert.equal(hsl.s, 1);
  assert.ok(Math.abs(hsl.l - 0.539) < 0.001, `lightness was ${hsl.l}`);
});

test('rgbToHsl reports greys as unsaturated', () => {
  assert.deepEqual(rgbToHsl({ r: 128, g: 128, b: 128 }), { h: 0, s: 0, l: 128 / 255 });
});

test('hex survives a round trip through HSL', () => {
  const samples = ['#39ff14', '#00891c', '#ffffff', '#000000', '#808080', '#4493f8', '#f85149'];
  for (const hex of samples) {
    assert.equal(toHex(hslToRgb(rgbToHsl(parseHex(hex)))), hex);
  }
});

test('hslToRgb normalises hues outside 0-360', () => {
  assert.equal(toHex(hslToRgb({ h: 480, s: 1, l: 0.5 })), toHex(hslToRgb({ h: 120, s: 1, l: 0.5 })));
  assert.equal(toHex(hslToRgb({ h: -120, s: 1, l: 0.5 })), toHex(hslToRgb({ h: 240, s: 1, l: 0.5 })));
});

// --- contrast --------------------------------------------------------------

test('contrastRatio matches the known WCAG extremes', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
});

test('contrastRatio is symmetric and forgiving of junk', () => {
  assert.equal(contrastRatio('#39ff14', '#0d1117'), contrastRatio('#0d1117', '#39ff14'));
  assert.equal(contrastRatio('nope', '#ffffff'), 1);
});

test('the default green still clears AA on the dark theme it is meant for', () => {
  assert.ok(contrastRatio(DEFAULT_COLOR, THEME_BACKGROUNDS.dark) >= MIN_CONTRAST);
});

// --- storage ---------------------------------------------------------------

test('coerceColor accepts a hex string and normalises it', () => {
  assert.equal(coerceColor('#ABC'), '#aabbcc');
  assert.equal(coerceColor('39ff14'), '#39ff14');
});

test('coerceColor rejects anything that is not a usable hex string', () => {
  for (const value of [null, undefined, 'blue', 42, {}, [], { base: '#39ff14' }, '#12345']) {
    assert.equal(coerceColor(value), null, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('coerceSettings carries a valid color through and drops a broken one', () => {
  assert.equal(coerceSettings({ color: '#ff0000' }).color, '#ff0000');
  assert.equal(coerceSettings({ color: 'nope' }).color, null);
  assert.equal(coerceSettings({ color: { base: '#ff0000' } }).color, null);
  assert.equal(coerceSettings({}).color, null);
});

test('parseImport restores an exported color', () => {
  const json = JSON.stringify({
    version: 1,
    color: '#ff0000',
    mappings: { u1069002: 'Obie Munoz' },
  });
  assert.equal(parseImport(json).color, '#ff0000');
});

test('parseImport reports no color when the file predates the setting', () => {
  assert.equal(parseImport('{"u1069002":"Obie Munoz"}').color, null);
});
