// scan: walk the repo, extract structure, reconcile the graph, regenerate MAP.md.
//
// Every file is read and analyzed on every scan. The content hash is not a speed shortcut - it is
// how the file graph knows when an agent-written summary has gone stale. Re-analyzing everything keeps
// edges correct when a previously-unresolvable import suddenly resolves because a file landed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addEdge, addNode, filesDir, dropEdges, estTokens, EXPAND_EDGE_TYPES, fail, idFor, isGitRepo,
  joinPosix, loadConfig, loadGraph, makeMatcher, normalizeLF, run, saveGraph, sha8,
  SCAN_EDGE_TYPES, SCAN_SOURCE_PREFIX, toPosix, truncate, writeFileAtomic,
} from './store.mjs';
import { analyze, EXT_LANG, resolveSpec, structuralSummary } from './lang.mjs';
import { buildIndex } from './index.mjs';
import { gitOverlay } from './git.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.join(HERE, '..', '..', 'assets', 'self-manifest.json');

const ENTRY_NAMES = new Set([
  'index.ts', 'index.js', 'index.mjs', 'index.tsx',
  'src/index.ts', 'src/index.js', 'src/index.mjs', 'src/index.tsx', 'src/index.jsx',
  'src/main.ts', 'src/main.js', 'src/app.ts', 'src/server.ts',
  'server.js', 'server.ts', 'app.js', 'app.ts',
  'main.py', 'app.py', '__main__.py', 'src/main.py', 'manage.py',
  'src/main.rs', 'src/lib.rs', 'main.go', 'Program.cs',
]);

const TEST_PATTERNS = [
  /^(.*)\.(test|spec)\.[A-Za-z0-9]+$/,
  /^test_(.*)\.py$/,
  /^(.*)_test\.(go|py|rs)$/,
  /^(.*)Test\.java$/,
];

// A directory holding a SKILL.md is an installed agent skill -- Scope or any other. It is
// tooling that happens to sit in the repo, not the repo's own code: nothing
// here imports it and nobody edits it from this project, so indexing it buries the real graph
// under hundreds of nodes that cost context on every query and answer nothing about the code.
// Detected by the marker file rather than a name list, so it covers skills wherever they are
// vendored (.claude/skills/, skills/, tools/) and covers ones not written yet.
// A SKILL.md at the repo ROOT is not a skill tree -- that is a repo whose product is a skill,
// and excluding it would empty the graph. Likewise a plugin repo (.claude-plugin/plugin.json at
// the root) ships its skills: outside .claude/ they are its own code, not vendored tooling.
export function skillTreeMatcher(rels) {
  const plugin = rels.includes('.claude-plugin/plugin.json');
  const roots = rels
    .filter((r) => r.endsWith('/SKILL.md') && (!plugin || r.startsWith('.claude/')))
    .map((r) => r.slice(0, -'SKILL.md'.length));
  if (!roots.length) return () => false;
  return (rel) => roots.some((r) => rel.startsWith(r));
}

export function listFiles(root, config) {
  const ignore = makeMatcher(config.ignore || []);
  let rels = [];
  let degraded = false;

  const g = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
  if (g.ok) {
    rels = g.out.split('\0').filter(Boolean);
  } else {
    degraded = true;
    const walk = (dir, prefix) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === '.git' || e.name === '.scope') continue;
        const rel = prefix ? prefix + '/' + e.name : e.name;
        if (e.isDirectory()) { if (!ignore(rel + '/')) walk(path.join(dir, e.name), rel); }
        else if (e.isFile()) rels.push(rel);
      }
    };
    walk(root, '');
  }

  const maxBytes = (config.maxFileKB || 512) * 1024;
  const kept = [];
  const skipped = { ignored: 0, big: 0, binary: 0, gone: 0, skill: 0 };
  const inSkillTree = skillTreeMatcher(rels);
  for (const rel of [...new Set(rels)].sort()) {
    if (inSkillTree(rel)) { skipped.skill += 1; continue; }
    if (ignore(rel)) { skipped.ignored += 1; continue; }
    const abs = path.join(root, rel);
    let st;
    try { st = fs.statSync(abs); } catch { skipped.gone += 1; continue; }
    if (!st.isFile()) { skipped.gone += 1; continue; }
    if (st.size > maxBytes) { skipped.big += 1; continue; }
    kept.push(rel);
  }
  return { files: kept, skipped, degraded };
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function langOf(rel) {
  const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
  return EXT_LANG[ext] || 'text';
}

function isAdr(rel) { return /(^|\/)docs\/adr\/[^/]+\.md$/i.test(rel); }

function testSubject(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  for (const re of TEST_PATTERNS) {
    const m = base.match(re);
    if (m) return m[1];
  }
  return null;
}

function packageEntries(root) {
  const p = path.join(root, 'package.json');
  if (!fs.existsSync(p)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = [];
    if (typeof pkg.main === 'string') out.push(pkg.main);
    if (typeof pkg.module === 'string') out.push(pkg.module);
    if (typeof pkg.bin === 'string') out.push(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === 'object') out.push(...Object.values(pkg.bin));
    return out.map((v) => String(v).replace(/^\.\//, ''));
  } catch { return []; }
}

function goModule(root) {
  const p = path.join(root, 'go.mod');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf8').match(/^module\s+(\S+)/m);
  return m ? m[1] : null;
}

function readJson(abs) {
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  try { return JSON.parse(text); } catch { /* fall through: tsconfig is JSONC in the wild */ }
  // Strip comments and trailing commas, skipping over string literals so "https://x" survives.
  const keepStrings = (m) => (m.startsWith('"') ? m : '');
  const jsonc = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/.*$/gm, keepStrings)
    .replace(/"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/g, keepStrings);
  try { return JSON.parse(jsonc); } catch { return null; }
}

// Workspace packages by name: `@scope/name` -> { dir, map: { '.': 'src/index.ts', './sub': ... } }.
// Every directory holding a package.json counts; no workspace globs to parse, node_modules is ignored.
function workspacePackages(root, dirs) {
  const out = new Map();
  const target = (v) => {
    if (typeof v === 'string') return v.replace(/^\.\//, '');
    if (v && typeof v === 'object') for (const k of ['source', 'import', 'default', 'types', 'require']) if (v[k]) return target(v[k]);
    return null;
  };
  for (const d of ['', ...dirs].sort()) {
    const pkg = readJson(path.join(root, d, 'package.json'));
    if (!pkg || typeof pkg.name !== 'string') continue;
    const map = {};
    if (typeof pkg.exports === 'string') map['.'] = target(pkg.exports);
    else if (pkg.exports && typeof pkg.exports === 'object') {
      for (const [k, v] of Object.entries(pkg.exports)) { const t = target(v); if (t && k.startsWith('.')) map[k] = t; }
    }
    if (!map['.']) map['.'] = target(pkg.source || pkg.types || pkg.module || pkg.main) || 'src/index.ts';
    out.set(pkg.name, { dir: d, map });
  }
  return out;
}

// tsconfig `paths` rules, nearest config first. `extends` is followed so a base config's aliases
// apply to every project under it; baseUrl is relative to the config that declares it.
function tsPathRules(root, dirs) {
  const out = [];
  for (const d of ['', ...dirs]) {
    let cfgDir = d;
    let cfg = readJson(path.join(root, d, 'tsconfig.json'));
    for (let hops = 0; cfg && hops < 5; hops += 1) {
      const co = cfg.compilerOptions || {};
      if (co.paths) {
        const base = joinPosix(cfgDir, co.baseUrl || '.');
        const rules = Object.entries(co.paths).map(([pat, targets]) => {
          const [pre, suf = ''] = pat.split('*');
          return { pre, suf, targets: [].concat(targets).map(String) };
        });
        out.push({ dir: d, base, rules });
        break;
      }
      if (typeof cfg.extends !== 'string' || !cfg.extends.startsWith('.')) break;
      const ext = joinPosix(cfgDir, cfg.extends.endsWith('.json') ? cfg.extends : cfg.extends + '.json');
      cfgDir = ext.includes('/') ? ext.slice(0, ext.lastIndexOf('/')) : '';
      cfg = readJson(path.join(root, ext));
    }
  }
  return out.sort((a, b) => b.dir.length - a.dir.length);
}

export function scan(ctx, argv) {
  const full = argv.includes('--full');
  const { root } = ctx;
  const dir = filesDir(root);
  if (!fs.existsSync(dir)) fail('no .scope/files store here — run `scope scan` first');
  const config = loadConfig(dir);
  const maxChars = config.summaryMaxChars || 200;
  const graph = loadGraph(dir);
  const warnings = [...graph.warnings];

  const { files, skipped, degraded } = listFiles(root, config);
  if (degraded) warnings.push('not a git repo — ignore rules approximated, no push state available');

  // --- read and analyze ----------------------------------------------------
  const info = new Map();
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(root, rel)); } catch { continue; }
    if (isBinary(buf)) { skipped.binary += 1; continue; }
    const text = normalizeLF(buf.toString('utf8'));
    const lang = langOf(rel);
    info.set(rel, { rel, lang, hash: sha8(text), analysis: analyze(rel, text, lang) });
  }

  const known = new Set(info.keys());
  const dirWithFiles = new Set();
  for (const rel of known) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) dirWithFiles.add(parts.slice(0, i).join('/'));
  }
  const bySuffix = new Map();
  const byBase = new Map();
  for (const rel of known) {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(rel);
    const parts = rel.split('/');
    if (parts.length >= 2) {
      const suf = parts.slice(-2).join('/');
      if (!bySuffix.has(suf)) bySuffix.set(suf, []);
      bySuffix.get(suf).push(rel);
    }
  }
  const resolveCtx = {
    known,
    dirWithFiles,
    goModule: goModule(root),
    packages: workspacePackages(root, [...dirWithFiles]),
    tsPaths: tsPathRules(root, [...dirWithFiles]),
    langOf: (rel) => (info.get(rel) ? info.get(rel).lang : langOf(rel)),
    byPathSuffix: (suf) => bySuffix.get(suf) || [],
    byBasename: (b) => byBase.get(b) || [],
  };

  // A mention resolves to a known path, or to the one doc a numbered prefix identifies:
  // "ADR-3" / "ADR-0003" -> docs/adr/0003-*.md, "spec/07" -> spec/07-*.md. Ambiguous = no edge.
  const docPaths = [...known].filter((r) => info.get(r).lang === 'md').sort();
  const resolveDoc = (tok) => {
    if (known.has(tok)) return tok;
    const adr = tok.match(/^ADR[- ]?(\d{1,4})$/i);
    const hits = adr
      ? docPaths.filter((r) => isAdr(r) && r.slice(r.lastIndexOf('/') + 1).startsWith(adr[1].padStart(4, '0') + '-'))
      : docPaths.filter((r) => r.startsWith(tok) && /^[-._]/.test(r.slice(tok.length)));
    return hits.length === 1 ? hits[0] : null;
  };

  // --- node types ----------------------------------------------------------
  const entryGlobs = makeMatcher(config.entrypoints || []);
  const pkgEntries = new Set(packageEntries(root));
  const typeOf = (rel) => {
    if (isAdr(rel)) return 'adr';
    if (ENTRY_NAMES.has(rel) || pkgEntries.has(rel) || entryGlobs(rel)) return 'entry';
    if (/^cmd\/[^/]+\/main\.go$/.test(rel)) return 'entry';
    return 'file';
  };

  // --- reconcile file nodes ------------------------------------------------
  const stats = { new: 0, changed: 0, dead: 0, kept: 0 };
  const nodeOf = new Map(); // rel -> node
  const seenIds = new Set();

  for (const rel of [...known].sort()) {
    const rec = info.get(rel);
    const t = typeOf(rel);
    const id = idFor(t, rel, seenIds);
    seenIds.add(id);
    const prev = graph.nodes.get(id);
    const tags = tagsFor(rel, rec, config);
    const node = { id, t, k: rel, s: '', g: tags, h: rec.hash, a: rec.analysis.anchors.slice(0, 8) };

    if (prev && prev.by === 'agent' && !full) {
      node.s = prev.s;
      node.by = 'agent';
      node.ts = prev.ts;
      node.h = prev.h;
      if (prev.h !== rec.hash) { node.st = 'stale'; stats.changed += 1; } else stats.kept += 1;
    } else if (prev) {
      if (prev.h !== rec.hash) stats.changed += 1; else stats.kept += 1;
    } else {
      stats.new += 1;
    }
    nodeOf.set(rel, node);
  }

  // Drop file-ish nodes whose path vanished; keep them one cycle marked dead.
  for (const n of [...graph.nodes.values()]) {
    if (!['file', 'entry', 'adr'].includes(n.t)) continue;
    if (known.has(n.k) && nodeOf.has(n.k) && nodeOf.get(n.k).id === n.id) continue;
    if (known.has(n.k)) { graph.nodes.delete(n.id); continue; } // type changed; new id replaces it
    if (n.st === 'dead') { graph.nodes.delete(n.id); continue; }
    n.st = 'dead';
    stats.dead += 1;
  }

  // --- edges ---------------------------------------------------------------
  dropEdges(graph, (e) => SCAN_EDGE_TYPES.has(e[1]) && SCAN_SOURCE_PREFIX.test(e[0]));

  // A directory is a module when it gathers something: at least two files below it, and either a
  // file of its own or two child modules. Pass-through dirs (one nested file, or a lone child dir —
  // Next.js route folders, `src/` wrappers) are not modules; their contents attach to the nearest
  // ancestor that is. Decided deepest-first because the child-module count feeds the parent.
  const direct = new Map();
  const nested = new Map();
  for (const rel of known) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const d = parts.slice(0, i).join('/');
      nested.set(d, (nested.get(d) || 0) + 1);
      if (i === parts.length - 1) direct.set(d, (direct.get(d) || 0) + 1);
    }
  }
  const isMod = new Set();
  const childMods = new Map();
  for (const d of [...dirWithFiles].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))) {
    if (nested.get(d) >= 2 && ((direct.get(d) || 0) >= 1 || (childMods.get(d) || 0) >= 2)) {
      isMod.add(d);
      const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : null;
      if (parent) childMods.set(parent, (childMods.get(parent) || 0) + 1);
    }
  }
  const modOf = (p) => { // nearest module above a path, or null at the root
    let d = p;
    while (d.includes('/')) { d = d.slice(0, d.lastIndexOf('/')); if (isMod.has(d)) return d; }
    return null;
  };

  const modIds = new Map();
  const ensureMod = (d) => {
    if (modIds.has(d)) return modIds.get(d);
    const id = idFor('mod', d, seenIds);
    seenIds.add(id);
    modIds.set(d, id);
    return id;
  };

  const inDeg = new Map();
  const outDeg = new Map();
  const unresolved = { count: 0, external: 0 };

  for (const rel of [...known].sort()) {
    const node = nodeOf.get(rel);
    const rec = info.get(rel);
    for (const spec of rec.analysis.specs) {
      const hit = resolveSpec(spec, rel, resolveCtx);
      if (!hit) { if (spec.startsWith('.')) unresolved.count += 1; else unresolved.external += 1; continue; }
      if (typeof hit === 'object' && hit.mod) {
        const mid = ensureMod(hit.mod);
        addEdge(graph, node.id, 'imports', mid);
        outDeg.set(rel, (outDeg.get(rel) || 0) + 1);
        continue;
      }
      if (hit === rel) continue;
      const target = nodeOf.get(hit);
      if (!target) continue;
      addEdge(graph, node.id, 'imports', target.id);
      outDeg.set(rel, (outDeg.get(rel) || 0) + 1);
      inDeg.set(hit, (inDeg.get(hit) || 0) + 1);
    }

    // containment
    const home = modOf(rel);
    if (home) addEdge(graph, node.id, 'part-of', ensureMod(home));

    // tests
    const subject = testSubject(rel);
    if (subject) {
      const d = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const candidates = [...known].filter((o) => {
        if (o === rel || testSubject(o)) return false;
        const ob = o.slice(o.lastIndexOf('/') + 1);
        return ob.slice(0, ob.lastIndexOf('.')) === subject;
      });
      const sameDir = candidates.filter((o) => (o.includes('/') ? o.slice(0, o.lastIndexOf('/')) : '') === d);
      const pick = sameDir[0] || (candidates.length === 1 ? candidates[0] : null);
      if (pick) addEdge(graph, nodeOf.get(pick).id, 'tested-by', node.id);
    }

    // A doc mentioning a path documents it. Code citing a doc ("ADR-0003", "spec/07 §2") is the
    // same relation seen from the other end, so the edge still runs doc -> code.
    for (const mention of rec.analysis.mentions) {
      const hit = resolveDoc(mention);
      const target = hit ? nodeOf.get(hit) : null;
      if (!target || target.id === node.id) continue;
      if (rec.lang === 'md') addEdge(graph, node.id, 'documents', target.id);
      else if (info.get(hit).lang === 'md') addEdge(graph, target.id, 'documents', node.id);
    }
  }

  // module nodes + module hierarchy (Go import targets may have added dirs beyond isMod)
  for (const d of [...isMod].sort()) ensureMod(d);
  for (const [d, id] of modIds) {
    const prev = graph.nodes.get(id);
    const node = {
      id, t: 'mod', k: d, s: '',
      g: d.split('/').slice(0, config.moduleDepth || 2).map((x) => x.toLowerCase()),
    };
    if (prev && prev.by === 'agent' && !full) { node.s = prev.s; node.by = 'agent'; node.ts = prev.ts; }
    else node.s = truncate(`Module ${d} — ${direct.get(d) || 0} files (${nested.get(d) || 0} incl. nested)`, maxChars);
    addNode(graph, node);
    const parent = modOf(d);
    if (parent) addEdge(graph, id, 'part-of', ensureMod(parent));
  }
  // A module whose directory no longer qualifies (ignored, emptied, collapsed) dies like a file does.
  for (const n of [...graph.nodes.values()]) {
    if (n.t !== 'mod' || modIds.get(n.k) === n.id) continue;
    if (n.st === 'dead') { graph.nodes.delete(n.id); continue; }
    n.st = 'dead';
    stats.dead += 1;
  }

  // --- summaries and importance -------------------------------------------
  const degrees = [...known].map((r) => inDeg.get(r) || 0).filter((x) => x > 0).sort((a, b) => a - b);
  const quintile = (v) => {
    if (!v || !degrees.length) return 1;
    const rank = degrees.filter((d) => d <= v).length / degrees.length;
    return Math.min(5, 1 + Math.floor(rank * 5));
  };

  for (const rel of known) {
    const node = nodeOf.get(rel);
    const rec = info.get(rel);
    const counts = { in: inDeg.get(rel) || 0, out: outDeg.get(rel) || 0 };
    if (node.by !== 'agent') node.s = structuralSummary(rel, rec.analysis, counts, maxChars);
    node.w = quintile(counts.in);
    addNode(graph, node);
  }

  // Files that were expanded once stay expanded — otherwise symbol anchors would silently rot.
  const expanded = new Set();
  for (const n of graph.nodes.values()) {
    if (n.t !== 'sym') continue;
    const owner = n.k.slice(0, n.k.indexOf('#'));
    if (known.has(owner)) expanded.add(owner);
  }
  for (const rel of [...expanded].sort()) expandFile(root, rel, graph, config, seenIds);

  // --- self-knowledge ------------------------------------------------------
  const selfInfo = seedSelfKnowledge(graph, maxChars, config.selfKnowledge === true);
  if (selfInfo.drift) warnings.push(selfInfo.drift);

  saveGraph(dir, graph);
  const idx = buildIndex(dir, graph);
  const mapOver = writeMap(root, dir, config, graph, { known, modIds, nodeOf, unresolved, outDeg });
  if (mapOver) {
    warnings.push(`MAP.md is ${mapOver} tokens against a ${config.budgets.map_tokens} budget — `
      + 'it is read every session, so move detail into node summaries');
  }
  // Scan runs after every edit; the overlay is gitignored and costs ~50ms, so refreshing it here
  // keeps the [git:modified] badges honest without anyone remembering to run git-overlay.
  if (!degraded) { try { gitOverlay({ root }); } catch { /* push state is a nicety, not a scan failure */ } }

  return {
    files: known.size, ...stats, skipped,
    nodes: graph.nodes.size, edges: graph.edges.size, terms: idx.terms,
    unresolved, warnings,
  };
}

// --- expand: symbol-level nodes -------------------------------------------

// Intra-file `calls` edges are a heuristic: an occurrence of `name(` inside another symbol's line
// span. It cannot see dynamic dispatch and it will occasionally match a same-named local. That is
// an acceptable trade for a free call sketch inside one file; cross-file call graphs are not
// attempted at all because the same heuristic across files is mostly noise.
export function expandFile(root, rel, graph, config, seenIds) {
  const abs = path.join(root, rel);
  let text;
  try { text = normalizeLF(fs.readFileSync(abs, 'utf8')); } catch { return { created: 0, removed: 0 }; }
  const lang = langOf(rel);
  const rec = analyze(rel, text, lang);
  const hash = sha8(text);
  const maxChars = config.summaryMaxChars || 200;

  const fileNode = ['entry', 'file', 'adr'].map((t) => graph.byKey.get(t + ':' + rel)).find(Boolean);
  if (!fileNode) fail(`${rel} is not in the graph — run \`scope scan\` first`);

  const exported = new Set(rec.anchors.map(([n]) => n));
  const symbols = new Map();
  for (const [name, line] of [...rec.locals, ...rec.anchors]) {
    if (!symbols.has(name) || symbols.get(name) > line) symbols.set(name, line);
  }

  // Index this file's prior sym nodes BY KEY, not by id. A store written before ids were
  // made stable across re-expands can hold several nodes under one key; prefer the
  // agent-authored one so a re-expand recovers a human summary instead of dropping it.
  const prior = [...graph.nodes.values()].filter((n) => n.t === 'sym' && n.k.startsWith(rel + '#'));
  const priorByKey = new Map();
  for (const n of prior) {
    const cur = priorByKey.get(n.k);
    if (!cur || (n.by === 'agent' && cur.by !== 'agent')) priorByKey.set(n.k, n);
  }
  let removed = 0;
  for (const k of priorByKey.keys()) if (!symbols.has(k.slice(rel.length + 1))) removed += 1;

  // Drop this file's expand-owned edges FIRST, while both endpoints still resolve —
  // deleting the nodes first would strand the edges of every vanished symbol.
  dropEdges(graph, (e) => {
    if (!EXPAND_EDGE_TYPES.has(e[1])) return false;
    const src = graph.nodes.get(e[0]);
    const dst = graph.nodes.get(e[2]);
    const owns = (n) => n && ((n.t === 'sym' && n.k.startsWith(rel + '#')) || n.id === fileNode.id);
    return owns(src) && (e[1] === 'exports' || owns(dst));
  });
  // Then clear every prior sym node for this file. The loop below re-creates each
  // surviving symbol at its canonical id, so this also purges duplicates left behind
  // by older versions rather than carrying them forward forever.
  for (const n of prior) { graph.nodes.delete(n.id); graph.byKey.delete('sym:' + n.k); }

  const lines = text.split('\n');
  const ordered = [...symbols.entries()].sort((a, b) => a[1] - b[1]);
  const spans = ordered.map(([name, line], i) => ({
    name, line, end: i + 1 < ordered.length ? ordered[i + 1][1] - 1 : lines.length,
  }));

  let created = 0;
  const idOf = new Map();
  for (const { name, line } of spans) {
    const key = rel + '#' + name;
    const id = idFor('sym', key, seenIds);
    seenIds.add(id);
    idOf.set(name, id);
    const prev = priorByKey.get(key);
    const node = { id, t: 'sym', k: key, s: '', g: [lang], h: hash, a: [[name, line]] };
    if (prev && prev.by === 'agent') { node.s = prev.s; node.by = 'agent'; node.ts = prev.ts; node.h = prev.h; }
    else node.s = truncate(`${exported.has(name) ? 'exported ' : ''}${lang} symbol in ${rel} at line ${line}`, maxChars);
    if (!prev) created += 1;
    addNode(graph, node);
    if (exported.has(name)) addEdge(graph, fileNode.id, 'exports', id);
  }

  for (const { name, line, end } of spans) {
    const body = lines.slice(line, end).join('\n');
    for (const [other, otherId] of idOf) {
      if (other === name) continue;
      if (new RegExp(`\\b${other.replace(/[$]/g, '\\$')}\\s*\\(`).test(body)) {
        addEdge(graph, idOf.get(name), 'calls', otherId);
      }
    }
  }

  return { created, removed, total: spans.length, file: fileNode };
}

export function expand(ctx, argv) {
  const dir = filesDir(ctx.root);
  const config = loadConfig(dir);
  const graph = loadGraph(dir);
  const rel = toPosix(argv.find((a) => !a.startsWith('--')) || '').replace(/^\.\//, '');
  if (!rel) fail('usage: scope expand <path>');
  // This file's own sym ids must NOT count as taken. expandFile is about to re-derive
  // exactly those ids from exactly those keys, and idFor() treats a taken id as a
  // collision and lengthens the digest — so seeding them here minted a second node per
  // symbol on every re-run, growing the store without bound (16 -> 32 -> 48 ...).
  const seenIds = new Set();
  for (const n of graph.nodes.values()) {
    if (n.t === 'sym' && n.k.startsWith(rel + '#')) continue;
    seenIds.add(n.id);
  }
  const r = expandFile(ctx.root, rel, graph, config, seenIds);
  saveGraph(dir, graph);
  buildIndex(dir, graph);
  return r;
}

function tagsFor(rel, rec, config) {
  const tags = new Set();
  const parts = rel.split('/');
  for (const seg of parts.slice(0, Math.min(parts.length - 1, config.moduleDepth || 2))) {
    tags.add(seg.toLowerCase().replace(/^\./, ''));
  }
  if (testSubject(rel)) tags.add('test');
  if (rec.lang === 'md') tags.add('doc');
  if (rec.lang !== 'text' && rec.lang !== 'md') tags.add(rec.lang);
  return [...tags].filter(Boolean).sort();
}

// Skill nodes describe Scope itself, not the repo. They are off by default (`selfKnowledge`
// in .scope/files/config.json) because 30 nodes and 55 edges of tool documentation is context every
// query pays for and no edit to this project can ever change. Set it to true in a repo where
// you want Scope to be queryable about its own commands.
function seedSelfKnowledge(graph, maxChars, enabled) {
  // Cleared unconditionally: turning the flag off has to actually remove skill nodes from a
  // store that already has them, not leave 30 orphans nothing will ever collect.
  for (const n of [...graph.nodes.values()]) if (n.t === 'skill') graph.nodes.delete(n.id);
  dropEdges(graph, (e) => e[0].startsWith('k_') || e[2].startsWith('k_'));
  if (!enabled) return { count: 0, commands: [] };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) {
    return { drift: `self-manifest unreadable (${e.message})` };
  }
  // Truncate rather than trust the manifest: the summary budget is an invariant of the store,
  // so a careless manifest edit must not be able to breach it.
  for (const n of manifest.nodes) addNode(graph, { ...n, s: truncate(n.s, maxChars) });
  for (const [a, t, b] of manifest.edges) addEdge(graph, a, t, b);
  return { count: manifest.nodes.length, commands: manifest.commands };
}

export function checkSelfDrift(commands) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; }
  const declared = new Set(manifest.commands);
  const actual = new Set(commands);
  const missing = [...actual].filter((c) => !declared.has(c));
  const extra = [...declared].filter((c) => !actual.has(c));
  if (!missing.length && !extra.length) return null;
  const bits = [];
  if (missing.length) bits.push(`not in manifest: ${missing.join(', ')}`);
  if (extra.length) bits.push(`manifest lists missing commands: ${extra.join(', ')}`);
  return `self-knowledge drift — ${bits.join('; ')} (edit assets/self-manifest.json)`;
}

// --- MAP.md ----------------------------------------------------------------

const BEGIN = (name) => `<!-- scope:auto:begin ${name} -->`;
const END = (name) => `<!-- scope:auto:end ${name} -->`;

function replaceSection(text, name, body) {
  const b = BEGIN(name);
  const e = END(name);
  const bi = text.indexOf(b);
  const ei = text.indexOf(e);
  const block = `${b}\n${body}\n${e}`;
  if (bi === -1 || ei === -1 || ei < bi) return text.trimEnd() + (text.trim() ? '\n\n' : '') + block + '\n';
  return text.slice(0, bi) + block + text.slice(ei + e.length);
}

function writeMap(root, dir, config, graph, extra) {
  // One map for both engines, at the top of the data folder.
  const file = path.join(root, '.scope', 'MAP.md');
  const name = config.name || path.basename(root);
  let text = fs.existsSync(file) ? normalizeLF(fs.readFileSync(file, 'utf8')) : '';

  if (!text.trim()) {
    text = `# ${name} — repo map\n\n${BEGIN('overview')}\n${END('overview')}\n\n`
      + '## Orientation\n\n'
      + '_Agent-authored. What is this project, what are the load-bearing pieces, what should a\n'
      + 'newcomer know that the file tree does not show? Scan never overwrites this section._\n\n'
      + `${BEGIN('howto')}\n${END('howto')}\n`;
  }

  const nodes = [...graph.nodes.values()];
  const byType = {};
  for (const n of nodes) byType[n.t] = (byType[n.t] || 0) + 1;
  const langs = {};
  for (const n of nodes) {
    if (!['file', 'entry', 'adr'].includes(n.t)) continue;
    for (const g of n.g || []) if (['ts', 'py', 'go', 'rs', 'java', 'cs', 'doc'].includes(g)) langs[g] = (langs[g] || 0) + 1;
  }
  // Rank by files directly inside, not nested totals: a pass-through directory that only holds
  // one subdirectory tells a reader nothing, and listing it crowds out a module that does.
  const mods = nodes.filter((n) => n.t === 'mod')
    .map((n) => ({
      n,
      c: [...extra.known].filter((r) => r.startsWith(n.k + '/') && !r.slice(n.k.length + 1).includes('/')).length,
    }))
    .filter((m) => m.c > 0)
    .sort((a, b) => b.c - a.c || a.n.k.localeCompare(b.n.k))
    .slice(0, 6);
  // The entries worth naming are the ones that pull the most in (a server, an app shell), not the
  // six that sort first — in a Next.js app that is six route pages in alphabetical order.
  const fanOut = (n) => extra.outDeg.get(n.k) || 0;
  const entries = nodes.filter((n) => n.t === 'entry').sort((a, b) => fanOut(b) - fanOut(a) || a.k.localeCompare(b.k)).slice(0, 6);
  const stale = nodes.filter((n) => n.st === 'stale').length;
  const dead = nodes.filter((n) => n.st === 'dead').length;

  const overview = [
    `**${name}** — ${extra.known.size} files, ${graph.nodes.size} nodes, ${graph.edges.size} edges.`,
    `Types: ${Object.entries(byType).sort().map(([t, c]) => `${t} ${c}`).join(' · ')}.`,
    Object.keys(langs).length ? `Languages: ${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l} ${c}`).join(' · ')}.` : '',
    '',
    // Paths only: `scope context <path>` works, and eleven hex ids cost ~60 tokens every session.
    `**Modules**: ${mods.map((m) => `\`${m.n.k}\` ${m.c}`).join(' · ')}`,
    entries.length ? `**Entrypoints**: ${entries.map((e) => `\`${e.k}\``).join(' · ')}` : '',
    stale || dead ? `\n_${stale} stale, ${dead} dead — run \`scope verify\`._` : '',
  ].filter((l) => l !== '').join('\n');

  const sample = mods[0] ? mods[0].n.k : (entries[0] ? entries[0].k : 'src');
  // Deliberately terse: the full protocol lives in SKILL.md, and duplicating it here would spend
  // the session-start budget saying the same thing twice.
  const howto = [
    '```bash',
    'node "<scope>/scripts/scope.mjs" query "nouns of your task"   # ranked hits, ~40 tokens each',
    `node "<scope>/scripts/scope.mjs" context ${sample}`,
    `node "<scope>/scripts/scope.mjs" impact ${sample}             # REQUIRED before any edit`,
    '```',
    'Query before you Grep; impact before you edit. `<scope>` is the `msnc:scope` skill folder: the skill has the full path and the protocol.',
  ].join('\n');

  text = replaceSection(text, 'overview', overview);
  text = replaceSection(text, 'howto', howto);
  writeFileAtomic(file, text);

  const budget = (config.budgets && config.budgets.map_tokens) || 600;
  const tokens = estTokens(text.length);
  return tokens > budget ? tokens : 0;
}

// --- init ------------------------------------------------------------------

export function init(ctx) {
  const { root } = ctx;
  const dir = filesDir(root);
  const created = [];
  for (const sub of ['', 'graph', 'index', 'overlays', 'view']) {
    const p = sub ? path.join(dir, sub) : dir;
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); created.push(toPosix(path.relative(root, p))); }
  }

  const cfgPath = path.join(dir, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    const cfg = { ...loadConfig(dir), name: path.basename(root) };
    writeFileAtomic(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    created.push('.scope/files/config.json');
  }

  const giPath = path.join(root, '.gitignore');
  const want = ['.scope/files/overlays/', '.scope/files/view/'];
  let gi = fs.existsSync(giPath) ? normalizeLF(fs.readFileSync(giPath, 'utf8')) : '';
  // A repo that already ignores `.scope/` wholesale does not need `.scope/files/overlays/` too,
  // and appending it anyway leaves every fresh checkout with a modified .gitignore after
  // its first scan. Covered means: an exact match, or an existing rule that is a parent
  // directory of the one we want.
  const rules = gi.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const covered = (w) =>
    rules.some((l) => {
      if (l === w) return true;
      const dir = l.endsWith('/') ? l : l + '/';
      return dir.length > 1 && w.startsWith(dir);
    });
  const missing = want.filter((w) => !covered(w));
  if (missing.length) {
    gi = (gi.trimEnd() + (gi.trim() ? '\n' : '') + missing.join('\n') + '\n');
    writeFileAtomic(giPath, gi);
    created.push('.gitignore (+' + missing.join(', ') + ')');
  }

  // No CLAUDE.md routing block: MSNC's Tuner does the routing.

  const gitOk = isGitRepo(root);
  return { root, created, gitOk };
}
