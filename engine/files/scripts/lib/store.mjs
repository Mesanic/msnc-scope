// Store primitives: repo discovery, config, deterministic JSONL graph I/O, ids, globs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const NODE_KEYS = ['id', 't', 'k', 's', 'g', 'h', 'a', 'st', 'w', 'by', 'ts'];

export const TYPE_PREFIX = {
  file: 'f', mod: 'm', sym: 'y', concept: 'c', adr: 'd',
  entry: 'e', note: 'n', issue: 'i', skill: 'k',
};

export const NODE_TYPES = new Set(Object.keys(TYPE_PREFIX));

export const EDGE_TYPES = new Set([
  'imports', 'exports', 'part-of', 'tested-by', 'documents', 'calls',
  'blocks', 'closes', 'mentions', 'relates', 'implements',
]);

// Edge types rebuilt from source on every scan. Everything else survives.
// `exports` and `calls` belong to `expand`, which rebuilds them per file; `blocks`/`closes`/
// `mentions` belong to issue sync; `relates`/`implements` belong to the agent and are never
// machine-deleted.
export const SCAN_EDGE_TYPES = new Set(['imports', 'part-of', 'tested-by', 'documents']);
export const EXPAND_EDGE_TYPES = new Set(['exports', 'calls']);
export const ISSUE_EDGE_TYPES = new Set(['blocks', 'closes', 'mentions']);

// Node-id prefixes whose outgoing scan-owned edges scan is allowed to rebuild. Issue (`i`) and
// skill (`k`) nodes also use `part-of`, and those relations are owned elsewhere.
export const SCAN_SOURCE_PREFIX = /^[fmed]/;

export const DEFAULT_CONFIG = {
  v: 1,
  name: '',
  ignore: [
    'node_modules/**', 'dist/**', 'build/**', 'out/**', 'target/**', 'vendor/**',
    '.scope/**', '.git/**', '.venv/**', '__pycache__/**',
    '*.min.*', '*.lock', 'package-lock.json', '*.map', '*.snap', '*.log',
    // drizzle-kit's generated migration state: thousands of lines that describe the schema files already indexed
    '**/meta/_journal.json', '**/meta/*_snapshot.json',
  ],
  maxFileKB: 512,
  // Seed the 30 nodes describing Scope's own commands into this repo's graph. Off: they are
  // the same in every project, cost context on every query, and say nothing about this code.
  selfKnowledge: false,
  moduleDepth: 2,
  summaryMaxChars: 200,
  entrypoints: [],
  externalDeps: false,
  budgets: { map_tokens: 600, query_tokens: 1500, context_tokens: 900, store_tokens: 50000 },
  github: { enabled: true, issueLimit: 200, linkCommits: 200 },
};

export class ScopeError extends Error {}

export function fail(msg) { throw new ScopeError(msg); }

// --- process helpers -------------------------------------------------------

export function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: opts.encoding === 'buffer' ? undefined : 'utf8',
      cwd: opts.cwd,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { ok: true, out: opts.encoding === 'buffer' ? out : String(out) };
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr) : '';
    return {
      ok: false,
      out: e.stdout ? String(e.stdout) : '',
      err: stderr || e.message,
      code: typeof e.status === 'number' ? e.status : -1,
      missing: e.code === 'ENOENT',
    };
  }
}

// --- repo discovery --------------------------------------------------------

export function findRoot(cwd = process.cwd()) {
  const g = run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (g.ok) return path.resolve(g.out.trim());
  let d = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(d, '.scope'))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(cwd);
    d = up;
  }
}

export function filesDir(root) { return path.join(root, '.scope', 'files'); }

export function isGitRepo(root) {
  return run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }).ok;
}

// --- hashing and ids -------------------------------------------------------

export function normalizeLF(text) { return text.replace(/\r\n/g, '\n'); }

export function sha8(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex').slice(0, 8);
}

export function idFor(type, key, taken) {
  if (type === 'issue') return 'i' + String(key).replace(/^#/, '');
  const prefix = TYPE_PREFIX[type] || 'x';
  const digest = createHash('sha256').update(type + ':' + key, 'utf8').digest('hex');
  let id = prefix + digest.slice(0, 6);
  if (taken) {
    let n = 6;
    while (taken.has(id) && n < 20) { n += 1; id = prefix + digest.slice(0, n); }
  }
  return id;
}

// --- globs -----------------------------------------------------------------

export function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else { re += '.*'; }
      } else { re += '[^/]*'; }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

export function makeMatcher(globs) {
  const res = globs.map(globToRe);
  return (rel) => {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    return res.some((r) => r.test(rel) || r.test(base));
  };
}

// --- config ----------------------------------------------------------------

export function loadConfig(dir) {
  const p = path.join(dir, 'config.json');
  if (!fs.existsSync(p)) return { ...DEFAULT_CONFIG };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    fail(`.scope/files/config.json is not valid JSON (${e.message})`);
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    budgets: { ...DEFAULT_CONFIG.budgets, ...(raw.budgets || {}) },
    github: { ...DEFAULT_CONFIG.github, ...(raw.github || {}) },
  };
}

export function saveConfig(dir, config) {
  writeFileAtomic(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

// --- node / edge serialization --------------------------------------------

export function nodeLine(n) {
  const o = {};
  for (const key of NODE_KEYS) {
    const v = n[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (key === 'st' && v === 'ok') continue;
    if (key === 'w' && v === 1) continue;
    if (key === 'by' && v === 'scan') continue;
    o[key] = v;
  }
  return JSON.stringify(o);
}

export function edgeKey(e) { return e[0] + '\t' + e[1] + '\t' + e[2]; }

// --- graph I/O -------------------------------------------------------------

export function loadGraph(dir) {
  const nodes = new Map();
  const byKey = new Map();
  const edges = new Map();
  const warnings = [];

  const nodesPath = path.join(dir, 'graph', 'nodes.jsonl');
  if (fs.existsSync(nodesPath)) {
    const lines = fs.readFileSync(nodesPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const n = JSON.parse(line);
        if (!n.id || !n.t || n.k === undefined) throw new Error('missing id/t/k');
        nodes.set(n.id, n);
        byKey.set(n.t + ':' + n.k, n);
      } catch (e) {
        warnings.push(`nodes.jsonl:${i + 1} skipped (${e.message}); run scan --full to rebuild`);
      }
    }
  }

  const edgesPath = path.join(dir, 'graph', 'edges.jsonl');
  if (fs.existsSync(edgesPath)) {
    const lines = fs.readFileSync(edgesPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (!Array.isArray(e) || e.length < 3) throw new Error('not an edge triple');
        edges.set(edgeKey(e), e);
      } catch (e) {
        warnings.push(`edges.jsonl:${i + 1} skipped (${e.message}); run scan --full to rebuild`);
      }
    }
  }

  return { dir, nodes, byKey, edges, warnings };
}

export function saveGraph(dir, graph) {
  fs.mkdirSync(path.join(dir, 'graph'), { recursive: true });
  const ids = [...graph.nodes.keys()].sort();
  const nodeText = ids.map((id) => nodeLine(graph.nodes.get(id))).join('\n') + (ids.length ? '\n' : '');
  writeFileAtomic(path.join(dir, 'graph', 'nodes.jsonl'), nodeText);

  const keys = [...graph.edges.keys()].sort();
  const edgeText = keys.map((k) => JSON.stringify(graph.edges.get(k))).join('\n') + (keys.length ? '\n' : '');
  writeFileAtomic(path.join(dir, 'graph', 'edges.jsonl'), edgeText);
}

export function addNode(graph, node) {
  graph.nodes.set(node.id, node);
  graph.byKey.set(node.t + ':' + node.k, node);
  return node;
}

export function removeNode(graph, id) {
  const n = graph.nodes.get(id);
  if (!n) return;
  graph.nodes.delete(id);
  graph.byKey.delete(n.t + ':' + n.k);
}

export function addEdge(graph, src, type, dst, meta) {
  if (!EDGE_TYPES.has(type)) fail(`unknown edge type "${type}"`);
  if (src === dst) return;
  const e = meta ? [src, type, dst, meta] : [src, type, dst];
  graph.edges.set(edgeKey(e), e);
}

export function dropEdges(graph, predicate) {
  let n = 0;
  for (const [k, e] of graph.edges) {
    if (predicate(e)) { graph.edges.delete(k); n += 1; }
  }
  return n;
}

// --- file helpers ----------------------------------------------------------

export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function estTokens(chars) { return Math.round(chars / 4); }

export function truncate(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function toPosix(p) { return p.split(path.sep).join('/'); }

// Resolve a path relative to another repo-relative file path, POSIX-style.
export function joinPosix(fromDir, rel) {
  const parts = (fromDir === '.' ? [] : fromDir.split('/')).concat(rel.split('/'));
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}
