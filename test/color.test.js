'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/common.js');
const {
  DEFAULT_COLORS,
  THEME_BACKGROUNDS,
  MIN_CONTRAST,
  parseHex,
  toHex,
  normalizeHex,
  rgbToHsl,
  hslToRgb,
  contrastRatio,
  fitToBackground,
  deriveThemeColors,
  coerceColor,
  resolveColors,
  coerceSettings,
  parseImport,
} = globalThis.GHUN;

/** Contrast of a variant against the background it will actually sit on. */
function ratio(colors, theme) {
  return contrastRatio(colors[theme], THEME_BACKGROUNDS[theme]);
}

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
  const hsl = rgbToHsl(parseHex(DEFAULT_COLORS.dark));
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

test('the shipped defaults still clear AA on their own themes', () => {
  assert.ok(contrastRatio(DEFAULT_COLORS.dark, THEME_BACKGROUNDS.dark) >= MIN_CONTRAST);
  assert.ok(contrastRatio(DEFAULT_COLORS.light, THEME_BACKGROUNDS.light) >= MIN_CONTRAST);
});

// --- refitting -------------------------------------------------------------

test('fitToBackground darkens a color that is too bright for white', () => {
  const fitted = fitToBackground('#39ff14', '#ffffff');
  assert.ok(contrastRatio(fitted, '#ffffff') >= MIN_CONTRAST);
  assert.ok(rgbToHsl(parseHex(fitted)).l < rgbToHsl(parseHex('#39ff14')).l);
});

test('fitToBackground brightens a color that is too dark for the dark theme', () => {
  const fitted = fitToBackground('#00891c', '#0d1117');
  assert.ok(contrastRatio(fitted, '#0d1117') >= MIN_CONTRAST);
  assert.ok(rgbToHsl(parseHex(fitted)).l > rgbToHsl(parseHex('#00891c')).l);
});

test('fitToBackground leaves a color that already clears the bar alone', () => {
  assert.equal(fitToBackground('#39ff14', '#0d1117'), '#39ff14');
  assert.equal(fitToBackground('#00891c', '#ffffff'), '#00891c');
});

test('fitToBackground holds the hue steady while it moves lightness', () => {
  const source = rgbToHsl(parseHex('#39ff14'));
  const fitted = rgbToHsl(parseHex(fitToBackground('#39ff14', '#ffffff')));
  assert.ok(Math.abs(fitted.h - source.h) < 1, `hue drifted from ${source.h} to ${fitted.h}`);
});

test('fitToBackground handles the achromatic extremes', () => {
  for (const [color, background] of [
    ['#000000', '#0d1117'],
    ['#ffffff', '#ffffff'],
    ['#0d1117', '#0d1117'],
  ]) {
    const fitted = fitToBackground(color, background);
    assert.ok(
      contrastRatio(fitted, background) >= MIN_CONTRAST,
      `${color} on ${background} refitted to ${fitted}`
    );
  }
});

// --- deriving the pair -----------------------------------------------------

test('deriveThemeColors keeps a dark-theme pick verbatim', () => {
  const colors = deriveThemeColors('#39ff14', 'dark');
  assert.equal(colors.dark, '#39ff14');
  assert.notEqual(colors.light, '#39ff14');
});

test('deriveThemeColors keeps a light-theme pick verbatim', () => {
  const colors = deriveThemeColors('#00891c', 'light');
  assert.equal(colors.light, '#00891c');
  assert.notEqual(colors.dark, '#00891c');
});

test('deriveThemeColors makes the derived variant readable from either side', () => {
  const picks = ['#39ff14', '#00891c', '#ff0000', '#0000ff', '#ffff00', '#000000', '#ffffff', '#808080'];
  for (const pick of picks) {
    for (const theme of ['dark', 'light']) {
      const colors = deriveThemeColors(pick, theme);
      const derived = theme === 'dark' ? 'light' : 'dark';
      assert.ok(
        ratio(colors, derived) >= MIN_CONTRAST,
        `${pick} picked on ${theme} derived ${colors[derived]} at ${ratio(colors, derived).toFixed(2)}:1`
      );
    }
  }
});

test('a derived dark variant is bright enough to hold its own', () => {
  // Aiming at the 4.5:1 floor here would land barely above the picked color,
  // because almost anything clears AA on a near-black canvas.
  for (const pick of ['#00891c', '#0969da', '#bf8700', '#1f883d']) {
    const colors = deriveThemeColors(pick, 'light');
    assert.ok(
      ratio(colors, 'dark') >= 7,
      `${pick} derived ${colors.dark} at only ${ratio(colors, 'dark').toFixed(2)}:1`
    );
  }
});

test('a derived dark variant stops before it bleaches out', () => {
  // Purple needs a near-white lightness to reach 7:1 and turns lavender getting
  // there, so the search settles for readable instead.
  const colors = deriveThemeColors('#8250df', 'light');
  const lightness = rgbToHsl(parseHex(colors.dark)).l;

  assert.ok(lightness <= 0.75, `lightness ran to ${lightness.toFixed(2)}`);
  assert.ok(ratio(colors, 'dark') >= MIN_CONTRAST);
});

test('the derived light variant lands where the hand-picked default did', () => {
  // #39ff14 is the shipped dark default and #00891c the light one that was
  // chosen by eye to go with it; the derivation should reach the same place.
  const derived = deriveThemeColors(DEFAULT_COLORS.dark, 'dark').light;
  const shipped = rgbToHsl(parseHex(DEFAULT_COLORS.light));
  const found = rgbToHsl(parseHex(derived));

  assert.ok(Math.abs(found.l - shipped.l) < 0.05, `${derived} vs ${DEFAULT_COLORS.light}`);
});

test('deriveThemeColors keeps both variants on the same hue', () => {
  const colors = deriveThemeColors('#4493f8', 'dark');
  const dark = rgbToHsl(parseHex(colors.dark));
  const light = rgbToHsl(parseHex(colors.light));
  assert.ok(Math.abs(dark.h - light.h) < 1, `${colors.dark} and ${colors.light} disagree on hue`);
});

test('deriveThemeColors falls back to the defaults on an unusable pick', () => {
  assert.deepEqual(deriveThemeColors('nope', 'dark'), DEFAULT_COLORS);
  assert.deepEqual(deriveThemeColors(null, 'light'), DEFAULT_COLORS);
});

// --- storage ---------------------------------------------------------------

test('coerceColor accepts a well-formed pick and normalises it', () => {
  assert.deepEqual(coerceColor({ base: '#ABC', theme: 'light' }), {
    base: '#aabbcc',
    theme: 'light',
  });
});

test('coerceColor defaults an unrecognised theme to dark', () => {
  assert.deepEqual(coerceColor({ base: '#39ff14' }), { base: '#39ff14', theme: 'dark' });
  assert.deepEqual(coerceColor({ base: '#39ff14', theme: 'sepia' }), {
    base: '#39ff14',
    theme: 'dark',
  });
});

test('coerceColor rejects anything without a usable base', () => {
  for (const value of [null, undefined, 'blue', 42, {}, { base: 'nope' }, { theme: 'dark' }]) {
    assert.equal(coerceColor(value), null, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('resolveColors falls back to the shipped pair when nothing is stored', () => {
  assert.deepEqual(resolveColors(null), DEFAULT_COLORS);
});

test('resolveColors expands a stored pick', () => {
  const colors = resolveColors({ base: '#ff0000', theme: 'dark' });
  assert.equal(colors.dark, '#ff0000');
  assert.ok(ratio(colors, 'light') >= MIN_CONTRAST);
});

test('coerceSettings carries a valid color through and drops a broken one', () => {
  assert.deepEqual(coerceSettings({ color: { base: '#ff0000', theme: 'light' } }).color, {
    base: '#ff0000',
    theme: 'light',
  });
  assert.equal(coerceSettings({ color: { base: 'nope' } }).color, null);
  assert.equal(coerceSettings({}).color, null);
});

test('parseImport restores an exported color', () => {
  const json = JSON.stringify({
    version: 1,
    color: { base: '#ff0000', theme: 'light' },
    mappings: { u1069002: 'Obie Munoz' },
  });
  assert.deepEqual(parseImport(json).color, { base: '#ff0000', theme: 'light' });
});

test('parseImport reports no color when the file predates the setting', () => {
  assert.equal(parseImport('{"u1069002":"Obie Munoz"}').color, null);
});
