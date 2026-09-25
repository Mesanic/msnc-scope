import { open, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LANGUAGES, languageForFile } from '../parsers/languages.mjs';
import { cmpStr, toPosix } from './util.mjs';

export const IGNORE_DIRS = Object.freeze([
  '.git',
  '__pycache__',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

const IGNORE_DIR_SET = new Set(IGNORE_DIRS);

export const MINIFIED_PATTERN = /\.min\.[^.]+$/;
export const BINARY_SNIFF_BYTES = 8192;

/**
 * Hard size cap for tracked source files. Anything larger is skipped BEFORE
 * reading/parsing and counted honestly (`skippedOversize` in scan output,
 * meta.stats and `scope stats`). Rationale: a multi-megabyte source file is
 * almost always generated/vendored data; parsing it wrecks scan latency for
 * near-zero map value, and downstream budgets (locate/slice caps) cannot save
 * a graph whose spans are megabytes wide. The skip is never silent.
 */
export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;

/**
 * Extensions that are known data/doc/asset formats rather than plausible
 * source code. Files with these extensions are never rough-extracted; the
 * structural fallback is for UNKNOWN source-like extensions only.
 */
export const DATA_DENYLIST_EXTS = Object.freeze(
  new Set([
    '.json', '.jsonl', '.ndjson', '.md', '.markdown', '.txt', '.rst', '.adoc',
    '.csv', '.tsv', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
    '.env', '.properties', '.mod', '.sum', '.lock', '.log',
    '.html', '.htm', '.css', '.scss', '.sass', '.less', '.svg',
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    '.map', '.pdf', '.zip', '.gz', '.tgz', '.br', '.wasm',
    '.sql', '.graphql', '.gql', '.proto', '.pb',
    '.icml', '.psd', '.ai', '.xlsx', '.docx', '.pptx',
    // Model weights, tensor dumps and build artifacts. None are source, but their
    // extensions are unknown to languageForFile, so without this they fall through to
    // the "unknown source-like extension" branch and get tracked -- then skipped by the
    // size cap, which reports them as if a real source file had been dropped.
    '.bin', '.safetensors', '.gguf', '.ckpt', '.pt', '.pth', '.onnx',
    '.npy', '.npz', '.parquet', '.arrow', '.tsbuildinfo',
  ]),
);

export function isIgnoredDirName(name) {
  return IGNORE_DIR_SET.has(name) || name.startsWith('.');
}

export function looksBinary(buffer) {
  const n = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function extensionSet() {
  const set = new Set();
  for (const spec of Object.values(LANGUAGES)) {
    for (const ext of spec.extensions) set.add(ext);
  }
  return set;
}

/**
 * Per-project ignore list, read from `<root>/.scope/symbols/config.json`:
 *
 *   { "ignoreDirs": ["runs", "apps/legacy"] }
 *
 * IGNORE_DIRS above is the universal set (node_modules, dist, ...). This is for
 * directories only this repo wants skipped -- an 18 GB experiment-output tree, a
 * vendored app -- which the walk would otherwise descend in full on every scan.
 * Entries are repo-relative posix paths, matched against the directory itself, so
 * both "runs" and "apps/legacy" work. Missing or malformed config = no extra
 * ignores; this must never be the reason a scan fails.
 */
export function readIgnoreDirs(rootDir) {
  try {
    const raw = readFileSync(path.join(rootDir, '.scope', 'symbols', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (!Array.isArray(cfg.ignoreDirs)) return [];
    return cfg.ignoreDirs.filter((d) => typeof d === 'string' && d.trim()).map((d) => toPosix(d.trim()).replace(/\/+$/, ''));
  } catch {
    return [];
  }
}

export async function walkSourceFiles(rootDir, ignoreDirs = readIgnoreDirs(rootDir)) {
  const exts = extensionSet();
  const extra = new Set(ignoreDirs);
  const plugin = existsSync(path.join(rootDir, '.claude-plugin', 'plugin.json'));
  const found = [];

  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM')) return;
      throw err;
    }
    // A directory holding a SKILL.md is an installed agent skill -- Scope or any other. Its source is tooling that happens to live in the repo: nothing here calls it,
    // nobody edits it from this project, and its symbols would outnumber the repo's own. The
    // marker file is the test, so it covers skills wherever they are vendored and ones written
    // later. The ROOT is exempt -- a repo whose product IS a skill still indexes itself -- and so
    // is a plugin repo (.claude-plugin/plugin.json), whose skills are its own code. Vendored
    // skills under .claude/ never get here: dot directories are pruned below.
    if (!plugin && dir !== rootDir && entries.some((e) => e.isFile() && e.name === 'SKILL.md')) return;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Prune before descending: the point is not to read an ignored tree at all.
        if (isIgnoredDirName(entry.name)) continue;
        if (extra.size && extra.has(toPosix(path.relative(rootDir, full)))) continue;
        await visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (MINIFIED_PATTERN.test(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const spec = languageForFile(entry.name);
      if (spec && exts.has(ext)) {
        found.push({ absPath: full, posixPath: toPosix(path.relative(rootDir, full)), lang: spec.id });
        continue;
      }
      if (!spec && ext !== '' && !DATA_DENYLIST_EXTS.has(ext)) {
        found.push({ absPath: full, posixPath: toPosix(path.relative(rootDir, full)), lang: null });
      }
    }
  }

  await visit(rootDir);
  found.sort((a, b) => cmpStr(a.posixPath, b.posixPath));
  return found;
}

export async function sniffBinary(absPath) {
  let handle;
  try {
    handle = await open(absPath, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return looksBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
