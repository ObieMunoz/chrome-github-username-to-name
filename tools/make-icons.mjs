/**
 * Regenerate the extension icons from a single SVG source.
 *
 * Uses macOS `sips` for rasterizing, so this is a local authoring tool, not
 * part of the build. Run with: npm run icons
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS_DIR = join(ROOT, 'icons');
const SIZES = [16, 32, 48, 128];

// A neon person on GitHub's dark canvas — legible down to 16px.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect width="128" height="128" rx="28" fill="#0d1117"/>
  <circle cx="64" cy="46" r="20" fill="#39ff14"/>
  <path d="M64 73c-21 0-38 14.2-38 31.8V110h76v-5.2C102 87.2 85 73 64 73z" fill="#39ff14"/>
</svg>
`;

mkdirSync(ICONS_DIR, { recursive: true });

const svgPath = join(ICONS_DIR, 'icon.svg');
writeFileSync(svgPath, SVG);

for (const size of SIZES) {
  execFileSync(
    'sips',
    ['-s', 'format', 'png', '-z', String(size), String(size), svgPath, '--out', join(ICONS_DIR, `icon${size}.png`)],
    { stdio: 'ignore' }
  );
  console.log(`icons/icon${size}.png`);
}
