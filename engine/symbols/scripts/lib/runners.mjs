import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { cmpStr } from './util.mjs';
import { IGNORE_DIRS } from './walk.mjs';

/**
 * Test-runner detection from marker files (M3 check test map).
 *
 * Markers are recognized at the repo root and at workspace levels below it
 * (bounded depth). One detected runner id per marker family, most specific
 * first for package.json:
 *   vitest / jest in dependencies|devDependencies  -> those ids
 *   otherwise scripts.test non-empty               -> npm-test
 *   pyproject.toml -> pytest · go.mod -> go-test · Cargo.toml -> cargo-test
 *
 * Output is deterministic: runners are deduplicated by id (first marker in
 * sorted walk order wins as the reported source) and returned sorted by id.
 * Malformed markers (e.g. unparseable package.json) are skipped, not fatal.
 */

export const RUNNER_IDS = Object.freeze([
  'cargo-test',
  'go-test',
  'jest',
  'npm-test',
  'pytest',
  'vitest',
]);

const MARKER_FILES = new Set(['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']);
const MAX_MARKER_DEPTH = 3;

/** Pure: runner ids implied by one parsed package.json object. */
export function runnersFromPackageJson(pkg) {
  if (!pkg || typeof pkg !== 'object') return [];
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const specific = [];
  if ('vitest' in deps) specific.push('vitest');
  if ('jest' in deps) specific.push('jest');
  if (specific.length > 0) return specific.sort(cmpStr);
  const hasTestScript = typeof pkg.scripts?.test === 'string' && pkg.scripts.test.trim() !== '';
  return hasTestScript ? ['npm-test'] : [];
}

/** Pure: runner ids implied by a marker file's raw text. */
export function runnersFromMarkerText(baseName, rawText) {
  if (baseName === 'package.json') {
    let pkg;
    try {
      pkg = JSON.parse(rawText);
    } catch {
      return [];
    }
    return runnersFromPackageJson(pkg);
  }
  if (baseName === 'pyproject.toml') return ['pytest'];
  if (baseName === 'go.mod') return ['go-test'];
  if (baseName === 'Cargo.toml') return ['cargo-test'];
  return [];
}

/**
 * Detect runners under rootAbs. Returns [{ id, source }] sorted by id, where
 * source is the repo-relative POSIX path of the first marker that claimed it.
 */
export async function detectRunners(rootAbs) {
  const found = new Map();

  async function visit(relDir, depth) {
    if (depth > MAX_MARKER_DEPTH) return;
    let entries;
    try {
      entries = await readdir(path.join(rootAbs, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => cmpStr(a.name, b.name));
    for (const entry of entries) {
      const relEntry = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.includes(entry.name) || entry.name.startsWith('.')) continue;
        await visit(relEntry, depth + 1);
        continue;
      }
      if (!entry.isFile() || !MARKER_FILES.has(entry.name)) continue;
      let raw = '';
      try {
        raw = await readFile(path.join(rootAbs, relEntry), 'utf8');
      } catch {
        continue;
      }
      for (const id of runnersFromMarkerText(entry.name, raw)) {
        if (!found.has(id)) found.set(id, relEntry);
      }
    }
  }

  await visit('', 0);
  return [...found.entries()].sort((a, b) => cmpStr(a[0], b[0])).map(([id, source]) => ({ id, source }));
}
