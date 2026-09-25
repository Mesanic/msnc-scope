// Files only the file graph knows (CSS, HTML): `impact` answers from the file graph and
// records the impact entry, so the pre-edit gate can clear. And `scan`
// leaves CLAUDE.md alone. The impact log (.scope/files/overlays/) drops stale entries and stays
// out of git before any scan adds its rule.
//   node --test scripts/impact-fallback.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IMPACT_TTL_MS, impactLogPath, recordImpact } from './impact-log.mjs';

const CLI = path.join(import.meta.dirname, 'scope.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-fallback-'));
  const files = {
    'src/util.ts': 'export function greet(n) { return "hi " + n; }\n',
    'src/app.ts': 'import { greet } from "./util";\nimport "./styles.css";\nexport function main() { return greet("x"); }\n',
    'src/styles.css': '.btn { color: red; }\n',
    'index.html': '<link rel="stylesheet" href="src/styles.css">\n',
  };
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  return root;
}

const scope = (root, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });
const logged = (root) => {
  try { return fs.readFileSync(impactLogPath(root), 'utf8'); } catch { return ''; }
};

const root = fixture();
const scan = scope(root, 'scan');

test('scan writes no CLAUDE.md and no .claude/ hooks', () => {
  assert.equal(scan.status, 0, scan.stderr);
  assert.ok(fs.existsSync(path.join(root, '.scope', 'files', 'graph', 'nodes.jsonl')));
  assert.ok(fs.existsSync(path.join(root, '.scope', 'symbols', 'index')));
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.claude')), false);
});

test('impact on a CSS file answers from the file graph and records the entry', () => {
  const r = scope(root, 'impact', 'src/styles.css');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /file graph only/);
  assert.match(r.stdout, /^ {2}src\/app\.ts$/m);
  assert.match(logged(root), /^\d+ src\/styles\.css$/m);
});

test('impact on an HTML file nothing imports says so and records the entry', () => {
  const r = scope(root, 'impact', './index.html');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no importers/);
  assert.match(logged(root), /^\d+ index\.html$/m);
});

test('a code file still goes through the symbol graph', () => {
  const r = scope(root, 'impact', 'src/util.ts');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^impact mod:/m);
  assert.doesNotMatch(r.stdout, /file graph only/);
});

test('a path neither graph knows still fails, and records nothing', () => {
  const r = scope(root, 'impact', 'nope.css');
  assert.equal(r.status, 2);
  assert.doesNotMatch(logged(root), /nope\.css/);
});

test('the impact log lives in .scope/files/overlays/ and recording drops entries past the TTL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-log-'));
  assert.equal(impactLogPath(dir), path.join(dir, '.scope', 'files', 'overlays', 'impact.log'));
  const old = Date.now() - IMPACT_TTL_MS - 60_000;
  const fresh = Date.now() - 60_000;
  fs.mkdirSync(path.dirname(impactLogPath(dir)), { recursive: true });
  fs.writeFileSync(impactLogPath(dir), `${old} src/old.ts\n${fresh} src/fresh.ts\n`);
  recordImpact(dir, 'src/new.ts');
  const lines = logged(dir).trimEnd().split('\n');
  assert.equal(lines.length, 2, logged(dir));
  assert.equal(lines[0], `${fresh} src/fresh.ts`);
  assert.match(lines[1], /^\d+ src\/new\.ts$/);
});

test('a log impact creates before any scan is never picked up by git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-git-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  recordImpact(dir, 'src/app.ts');
  assert.match(logged(dir), /^\d+ src\/app\.ts$/m);
  assert.doesNotMatch(git('status', '--porcelain', '-uall').stdout, /impact\.log/);
  git('add', '.scope');
  assert.doesNotMatch(git('diff', '--cached', '--name-only').stdout, /impact\.log/);
});
