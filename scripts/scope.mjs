#!/usr/bin/env node
// scope — runs the files and symbols engines as one instrument.
//
// It owns exactly two things neither tool can do alone:
//   scan    keep both stores in step (forgetting one silently degrades `impact`)
//   impact  cross-check symbol-level dependents against file-level importers
//
// Everything else is forwarded to the engine that owns it — see SKILL.md.
// The symbols engine is driven only through its CLI. The files engine has no complete
// machine-readable output (`context` truncates its importer list), so its graph store is
// read directly; that is the one coupling point, and readFileImporters() fails loudly
// rather than returning an empty set, because an empty set here reads as "nothing
// else to check" — the most dangerous possible wrong answer.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeIntoFileGraph } from './merge.mjs';
import { recordImpact } from './impact-log.mjs';

const HELP = `scope — one instrument for reading and changing a codebase

  it drives two graphs of your repo and reconciles them:
    file graph    modules, files, imports, git state, GitHub issues
    symbol graph  functions, calls, signatures, tests, notes

scope's own commands (these need both graphs)
  scope scan                 refresh both graphs
  scope impact <name|id>     dependents, cross-checked for blind spots
  scope impact <path>        same, at file altitude (whole-file dependents)
  scope view [--out f]       ONE interactive graph: module -> file -> symbol
  scope status               what is installed, what is indexed
  scope map                  the repo's orientation card

read (routed to whichever graph owns the answer)
  scope query "terms"        ranked retrieval across the file graph
  scope context <path|id>    one card: upstream, downstream, tests, docs, issues, git
  scope locate <name>        exact file, line span and signature for a symbol
  scope slice <id>           the definition itself, token-budgeted
  scope brief <id>           compact orientation card for a symbol
  scope neighbors <id>       adjacency by edge type   [--depth 1-3] [--dir in|out|both]
  scope path <a> <b>         how two nodes connect
  scope expand <path>        symbol nodes with line anchors, for ranged reads
  scope issues               GitHub issues, blockers and frontier

write back / verify
  scope check                exits 1 if anything dangles after an edit
  scope note symbol <...>    anchored symbol note (survives moves)
  scope note file <...>      file summary or edge in the file graph
  scope verify               find summaries that drifted and files that vanished
  scope prune                drop dead nodes, orphan edges, duplicates
  scope stats                size and counts for both graphs

options
  --root <dir>   project root (default: cwd)
  --depth <n>    impact / neighbors
  --out <file>   view: where to write the HTML

everything ships inside this folder (engine/). Overrides, if you keep the engines
elsewhere: $SCOPE_FILES and $SCOPE_SYMBOLS, absolute paths to their CLIs.`;

// fileURLToPath, not url.pathname: pathname is percent-encoded, so any space in the
// install path (e.g. "AI Projects") silently breaks tool discovery.
const here = path.dirname(fileURLToPath(import.meta.url));

function die(msg, code = 2) {
  console.error(`scope: ${msg}`);
  process.exit(code);
}

function findTool(envVar, bundledRel) {
  // An explicit env var is an override, not a hint: if it is set and wrong, say so
  // rather than quietly using a different install than the one that was asked for.
  const pinned = process.env[envVar];
  if (pinned) {
    if (fs.existsSync(pinned)) return pinned;
    die(`$${envVar} points at ${pinned}, which does not exist`);
  }
  // The engines ship inside this skill; there is no other place to look.
  const t = path.resolve(here, '..', 'engine', bundledRel);
  return fs.existsSync(t) ? t : null;
}

function tools() {
  return {
    files: findTool('SCOPE_FILES', 'files/scripts/files.mjs'),
    symbols: findTool('SCOPE_SYMBOLS', 'symbols/scripts/symbols.mjs'),
  };
}

// spawnSync, not execFileSync: the two tools disagree about which stream is for
// humans (symbols writes its scan summary to stderr, files to stdout), and on
// failure both put the useful message on whichever they prefer. spawnSync hands
// back both plus a status, with no exception to unpack.
function run(script, args, root, { merge = false } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) return die(`could not run ${path.basename(script)}: ${r.error.message}`);
  const out = r.stdout || '';
  const err = r.stderr || '';
  if (r.status !== 0) {
    const said = out.trim() || err.trim() || `exit ${r.status}`;
    return die(`${path.basename(script)} ${args[0]} failed —\n  ${said.replace(/\n/g, '\n  ')}`);
  }
  return merge ? out + err : out;
}

// --- file graph store -------------------------------------------------------
// Returns the set of files importing `targetFile`, per the file graph.
// Dies on anything unexpected: a silent empty set would read as "no blind spots".
const fileStore = new Map();
function readFileImporters(root, targetFile) {
  const dir = path.join(root, '.scope', 'files', 'graph');
  const nodesPath = path.join(dir, 'nodes.jsonl');
  const edgesPath = path.join(dir, 'edges.jsonl');
  for (const p of [nodesPath, edgesPath]) {
    if (!fs.existsSync(p)) {
      die(`file graph missing (${path.relative(root, p)}). Run: scope scan`);
    }
  }
  const parse = (p) =>
    fs
      .readFileSync(p, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l, i) => {
        try {
          return JSON.parse(l);
        } catch {
          return die(`file graph corrupt at ${path.basename(p)}:${i + 1}. Run: scope scan`);
        }
      });

  // Cached: the file-graph fallback in impact calls this once per importer it walks.
  if (!fileStore.has(root)) fileStore.set(root, [parse(nodesPath), parse(edgesPath)]);
  const [nodes, edges] = fileStore.get(root);
  if (!nodes.length || typeof nodes[0].id !== 'string' || !('k' in nodes[0])) {
    die('file graph node format not recognised — expected {id,t,k}. Reinstall this skill whole.');
  }
  if (!Array.isArray(edges[0]) || edges[0].length !== 3) {
    die('file graph edge format not recognised — expected ["src","type","dst"] triples. Reinstall this skill whole.');
  }

  const byId = new Map(nodes.map((n) => [n.id, n.k]));
  const fileNode = nodes.find((n) => n.k === targetFile && n.t !== 'sym');
  if (!fileNode) return null; // the file graph does not know this file — reported, not silently empty
  return new Set(
    edges
      .filter((e) => e[1] === 'imports' && e[2] === fileNode.id)
      .map((e) => byId.get(e[0]))
      .filter(Boolean),
  );
}

// --- commands ---------------------------------------------------------------

function cmdScan(root, { files, symbols }) {
  // No project hooks and no CLAUDE.md block: MSNC's dispatcher is the gate and its Tuner the routing.
  if (!files && !symbols) die('no engine found — this install is incomplete. See `scope status`');
  // Both inits are documented idempotent and additive, but both append to .gitignore — so
  // only run one when its store is genuinely absent, and say so rather than editing the repo silently.
  if (symbols && !fs.existsSync(path.join(root, '.scope', 'symbols', 'index'))) {
    console.log('symbol graph  init (first run — creating .scope/symbols/)');
    run(symbols, ['init'], root);
  }
  if (files && !fs.existsSync(path.join(root, '.scope', 'files', 'graph'))) {
    console.log('file graph    init (first run — creates .scope/files/, appends to .gitignore)');
    run(files, ['init'], root);
  }
  // Both tools put warnings on the same stream as their summary, and either may emit one
  // FIRST -- so taking the first line reports "warn: ..." and nothing else, which reads as
  // a scan that did not run. Report the summary, then the notes; but cap them, because
  // the symbols engine emits one line per oversize file and the summary already carries the count.
  const NOTE = /^(warn|note|warning):/i;
  const NOTE_CAP = 3;
  const summarize = (label, out) => {
    const lines = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const pad = ' '.repeat(label.length);
    console.log(`${label} ${lines.find((l) => !NOTE.test(l)) || '(no output)'}`);
    const notes = lines.filter((l) => NOTE.test(l));
    for (const n of notes.slice(0, NOTE_CAP)) console.log(`${pad} ${n}`);
    if (notes.length > NOTE_CAP) {
      console.log(`${pad} +${notes.length - NOTE_CAP} more (run that tool's scan directly for the full list)`);
    }
  };
  if (symbols) summarize('symbol graph ', run(symbols, ['scan'], root, { merge: true }));
  if (files) summarize('file graph   ', run(files, ['scan'], root, { merge: true }));
}

// One picture, both tiers. The file graph's viewer is the full-featured one -- node-type
// toggles, git state, tag facets, impact mode, flow, search over summaries -- and it already
// reserves `sym`/`calls`/`y` for a symbol tier it cannot populate. So the merge runs in
// that direction: the symbol graph's symbols go into the file graph and its own renderer
// draws it, unchanged. This CLI owns the fold (merge.mjs) and nothing else.
async function cmdView(root, { files, symbols }, outArg) {
  if (!files) die('file graph engine missing — it draws the viewer and every tier above the symbol');
  if (!symbols) die('symbol graph engine missing — without symbols there is no call tier to draw');
  const symbolsDir = path.join(root, '.scope', 'symbols', 'index');
  const filesDir = path.join(root, '.scope', 'files');
  if (!fs.existsSync(symbolsDir) || !fs.existsSync(path.join(filesDir, 'graph'))) {
    die('a store is missing. Run: scope scan');
  }

  const lib = path.resolve(path.dirname(files), 'lib');
  const load = async (f, name) => {
    const p = path.join(lib, f);
    if (!fs.existsSync(p)) die(`file graph engine ${f} not found at ${p} — incomplete install?`);
    const m = await import(pathToFileURL(p).href);
    if (typeof m[name] !== 'function') die(`file graph engine ${f} has no ${name} — version mismatch; reinstall this skill whole.`);
    return m;
  };
  const { loadGraph } = await load('store.mjs', 'loadGraph');
  const { graphHtml } = await load('html.mjs', 'graphHtml');

  const graph = loadGraph(filesDir);
  for (const w of graph.warnings) console.log(`warn: ${w}`);
  const before = graph.nodes.size;
  const stats = mergeIntoFileGraph({ fileGraph: graph, symbolsDir, die });

  const out = outArg ? path.resolve(root, outArg) : null;
  const r = graphHtml({ root, dir: filesDir }, graph, out);
  const where = r.file || path.join(filesDir, 'view', 'scope.html');

  console.log(`view ${path.relative(root, where)} (${r.nodes} nodes, ${r.edges} edges, ${Math.round(r.bytes / 1024)} KB)`);
  console.log(`files  ${before} nodes — files, modules, decisions, and their overlays`);
  console.log(`syms   +${stats.symbols} connected symbols across ${stats.joinedFiles} files`);
  console.log(`       ${stats.foldedLeaves} unconnected symbols folded into their file's anchor list, not drawn as dots`);
  console.log(`concepts ${stats.concepts.linked} linked by ${stats.concepts.edges} references parsed from their text, ${stats.concepts.stillIsolated} still isolated`);
  console.log(`modules  ${stats.mods.collapsed} pass-through nodes collapsed, ${stats.mods.enriched} given file/symbol/test aggregates`);
  console.log(`edges  +${stats.edges['part-of']} part-of, +${stats.edges.calls} calls, +${stats.edges.implements} implements`);
  console.log(`cross  +${stats.importsAdded} imports and +${stats.testsAdded} test links the file graph did not have`);
  const pv = stats.provenance;
  console.log(`seen by  both ${pv.both}, file graph only ${pv.files}, symbol graph only ${pv.symbols}  (filter in the sidebar)`);
  if (stats.check.ran) {
    const c = stats.check;
    console.log(`check  ${c.drift} drifted, ${c.dangling} dangling, ${c.orphan} orphaned notes, ${c.ambiguous} ambiguous (from \`scope check\`)`);
  } else {
    console.log('check  no lens — run `scope check` to overlay drift and dangling refs');
  }
  console.log(`notes  ${stats.notesAttached} attached from the symbol ledger${stats.notesStale ? `, ${stats.notesStale} unbound (code changed since written)` : ''}`);
  if (stats.skippedNoFile) {
    console.log(`note   ${stats.skippedNoFile} symbols skipped — in files the file graph does not track (different ignore rules)`);
  }
  console.log(`overlays git ${r.hasGit ? 'on' : 'off'}, issues ${r.hasIssues ? 'on' : "off (run: scope issues)"}`);
  console.log('');
  console.log('zoom is the tier control — modules zoomed out, then files, then symbols as you go in.');
}

function cmdStatus(root, { files, symbols }) {
  const mark = (b) => (b ? 'ok     ' : 'MISSING');
  const fStore = fs.existsSync(path.join(root, '.scope', 'files', 'graph', 'nodes.jsonl'));
  const sStore = fs.existsSync(path.join(root, '.scope', 'symbols', 'index'));
  console.log(`root           ${root}`);
  console.log(`file engine    ${mark(!!files)} ${files || '(bundled copy missing — set $SCOPE_FILES)'}`);
  console.log(`symbol engine  ${mark(!!symbols)} ${symbols || '(bundled copy missing — set $SCOPE_SYMBOLS)'}`);
  console.log(`file graph     ${mark(fStore)} .scope/files/`);
  console.log(`symbol graph   ${mark(sStore)} .scope/symbols/`);
  if (!fStore || !sStore) console.log('\nrun: scope scan');
}

// Resolve the target to {id, name, path}. Ambiguity is surfaced, never guessed.
// Only `name` and `path` are used downstream, for the cross-check.
// `onMiss` handles "no such symbol": impact passes one that falls back to the file graph.
function resolveTarget(symbols, root, key, onMiss = die) {
  // An id cannot be looked up with `locate` (that searches names, and an id's hex
  // suffix is not a name). `brief` takes an id and prints "brief <name> <id>" then
  // "def: <path>:<sl>-<el>", which is all the cross-check needs.
  if (/^[a-z]+:[0-9a-f]{6,}$/.test(key)) {
    const brief = run(symbols, ['brief', key], root, { merge: true });
    const name = /^brief\s+(\S+)\s/m.exec(brief)?.[1];
    const p = /^def:\s+(\S+?):\d+-\d+/m.exec(brief)?.[1];
    if (!name || !p) return die(`unknown id ${key} — the index may be stale. Run: scope scan`);
    return { id: key, name, path: p };
  }

  const raw = run(symbols, ['locate', key, '--json'], root).trim();
  if (!raw.startsWith('{')) {
    // the symbols engine reports "no results for ..." as plain text on a zero exit.
    return onMiss(`no symbol named "${key}" in the index. Try: scope locate ${key}`);
  }
  const hits = JSON.parse(raw).hits || [];
  // Modules match on path OR module name, so `impact kernel/router.py` resolves.
  // A module node is the symbol graph's file altitude: import edges connect modules and
  // collectImpact walks import, so this is a file-level dependency walk with --depth.
  const exact = hits.filter((h) =>
    h.kind === 'module' ? h.path === key || h.name === key : h.name === key,
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    console.error(`scope: "${key}" is ambiguous — pass one of these ids:`);
    for (const h of exact) {
      console.error(`  ${h.id}  ${h.kind} ${h.path}:${h.span.sl}-${h.span.el}`);
    }
    process.exit(2);
  }
  if (!hits.length) return onMiss(`no symbol named "${key}" — try: scope locate ${key}`);
  return onMiss(`no exact match for "${key}" — closest is ${hits[0].name} (${hits[0].id})`);
}

// A file only the file graph knows — CSS, HTML, anything without a grammar — has no
// symbol node, so the symbol walk cannot answer. Dying there left the pre-edit gate
// unsatisfiable for exactly those files. Answer from the file graph instead: its
// importers, transitively to --depth, and record the entry the gate reads.
function fileGraphImpact(root, file, depth) {
  recordImpact(root, file);
  console.log(`impact ${file} [up] (file graph only — no symbols for this file, so no line spans or tests)`);
  const max = Number(depth) || 32;
  const seen = new Set([file]);
  let frontier = [file];
  for (let hop = 1; hop <= max && frontier.length; hop++) {
    const next = [...new Set(frontier.flatMap((f) => [...(readFileImporters(root, f) || [])]))]
      .filter((f) => !seen.has(f))
      .sort();
    if (!next.length) break;
    console.log(hop === 1 ? `importers (${next.length})` : `depth ${hop} (${next.length})`);
    for (const f of next) { seen.add(f); console.log(`  ${f}`); }
    frontier = next;
  }
  if (seen.size === 1) console.log('no importers in the file graph.');
  // Import edges are all the file graph has. A stylesheet linked from HTML or a class name
  // used in markup is a reference it cannot see, so say where to look rather than imply "safe".
  console.log(`\nnot covered: references by name (<link>, <script>, class names). Check with: grep -rn "${path.basename(file)}" .`);
}

function cmdImpact(root, { files, symbols }, key, depth) {
  if (!symbols) die('symbol graph engine missing — it provides the symbol-level answer');
  const file = path.relative(root, path.resolve(root, key)).split(path.sep).join('/');
  const target = resolveTarget(symbols, root, key, (msg) =>
    (files && fs.existsSync(path.resolve(root, key)) && readFileImporters(root, file) !== null ? null : die(msg)));
  if (!target) return fileGraphImpact(root, file, depth);
  // Record the file this answer covers, so the pre-edit hook can tell an edit that was
  // analysed from one that was not.
  recordImpact(root, target.path);

  // 1. The symbol graph's report, passed through verbatim — it is budgeted, carries
  //    confidence labels and the test list, and must not be re-implemented here.
  const args = ['impact', target.id, '--up'];
  if (depth) args.push('--depth', depth);
  const report = run(symbols, args, root);
  process.stdout.write(report);

  // 2. Cross-check. Every repo-relative path the symbols engine printed is a file it reached.
  if (!files) {
    console.log('\ncross-check: skipped (file graph engine missing — no blind-spot triage)');
    return;
  }
  const importers = readFileImporters(root, target.path);
  if (importers === null) {
    console.log(`\ncross-check: skipped (the file graph has no node for ${target.path} — rescan?)`);
    return;
  }
  const covered = new Set(report.match(/[\w./-]+\.[A-Za-z]\w*/g) || []);
  const delta = [...importers].filter((f) => !covered.has(f) && f !== target.path).sort();

  console.log('');
  // `covered` is scraped from the symbol report, which is capped at 600 tokens. When it
  // truncates, files the symbols engine DID reach are absent from the scrape and appear below as
  // phantom blind spots. Say so rather than hand over a list that is quietly padded.
  if (report.includes(' more (narrow with --depth')) {
    console.log('note: the symbol report was truncated — this list may over-report.');
    console.log('      re-run with a smaller --depth for an exact cross-check.');
  }
  if (!delta.length) {
    console.log('cross-check: clean — every importer the file graph sees is accounted for.');
    return;
  }
  console.log(`cross-check (${delta.length}) — the file graph sees these importing ${target.path},`);
  if (target.id.startsWith('mod:')) {
    // File altitude: both sides are import graphs, so the "imports some other name"
    // case cannot arise. A delta entry means the symbol resolver dropped an import
    // the file graph resolved — an alias, a re-export, or a dynamic import. All are real.
    console.log('but the symbol graph did not resolve that import. Each is a REAL dependent whose');
    console.log('import could not be resolved (alias, re-export, dynamic import).');
    for (const f of delta) console.log(`  ${f}`);
    console.log('');
    console.log(`resolve by opening each file and finding the import of ${target.path}.`);
    return;
  }
  console.log('but symbol analysis did not reach them. Each is one of:');
  console.log('  (a) a dynamic call symbol analysis cannot resolve  -> a REAL dependent');
  console.log(`  (b) an import of some other name from ${path.basename(target.path)} -> ignore`);
  for (const f of delta) console.log(`  ${f}`);
  console.log(`\nresolve with: grep -n "${target.name}" <file>`);
}

// --- passthrough ------------------------------------------------------------
// scope is the only CLI a user of this skill learns. Commands it does not own are
// forwarded, unchanged, to whichever engine owns that answer -- so nothing is lost by
// never calling the engines directly, and there is no second command surface to explain.
// Flags and output are the engine's; only the name on the front is scope's.
const ROUTE = {
  // file graph: modules, imports, git and issue overlays, orientation
  query: 'files', context: 'files', neighbors: 'files', path: 'files',
  expand: 'files', issues: 'files', verify: 'files', prune: 'files', index: 'files',
  'git-overlay': 'files',
  // symbol graph: spans, definitions, drift
  locate: 'symbols', slice: 'symbols', brief: 'symbols', check: 'symbols',
};

const GRAPH_NAME = { files: 'file', symbols: 'symbol' };

function cmdPassthrough(root, found, cmd, rest, which = ROUTE[cmd]) {
  const tool = found[which];
  if (!tool) die(`the ${GRAPH_NAME[which]} graph engine is missing -- see \`scope status\``);
  process.stdout.write(run(tool, [cmd, ...rest], root, { merge: true }));
}

// `note` exists on both engines and means different things: a symbol note is anchored to
// a source hash and survives a move, a file note is a summary or an edge in the file
// graph. Guessing between them from the arguments would be a coin flip, so the altitude
// is named -- the same symbol/file split `impact` already uses.
function cmdNote(root, found, rest) {
  const at = rest[0];
  if (at === 'symbol') return cmdPassthrough(root, found, 'note', rest.slice(1), 'symbols');
  if (at === 'file') return cmdPassthrough(root, found, 'note', rest.slice(1), 'files');
  die([
    'usage: scope note symbol set <key> --text "..."',
    '       scope note file set-summary <path> --text "..."',
    '       scope note file edge <a> <b> --type <t>',
  ].join('\n'));
}

function cmdStats(root, { files, symbols }) {
  if (symbols) { console.log('symbol graph'); process.stdout.write(run(symbols, ['stats'], root, { merge: true })); }
  if (files) { console.log('\n' + 'file graph'); process.stdout.write(run(files, ['stats'], root, { merge: true })); }
}

// The orientation card, printed rather than pointed at: a path into a store directory is
// one more thing to remember, and reading this is the first move of a session.
function cmdMap(root) {
  const f = path.join(root, '.scope', 'MAP.md');
  if (!fs.existsSync(f)) die('no orientation card yet. Run: scope scan');
  process.stdout.write(fs.readFileSync(f, 'utf8'));
}

// --- main -------------------------------------------------------------------

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
  console.log(HELP);
  process.exit(0);
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const root = path.resolve(flag('--root') || process.cwd());
if (!fs.existsSync(root)) die(`no such root: ${root}`);
const found = tools();
const cmd = argv[0];
const rest = argv.slice(1);
const positional = rest.filter((a, i) => {
  if (a.startsWith('--')) return false;
  return !(i > 0 && ['--root', '--depth', '--out'].includes(rest[i - 1]));
});

if (cmd === 'scan') cmdScan(root, found);
else if (cmd === 'status') cmdStatus(root, found);
else if (cmd === 'view') await cmdView(root, found, flag('--out'));
else if (cmd === 'impact') {
  if (!positional.length) die('usage: scope impact <name|id>');
  cmdImpact(root, found, positional[0], flag('--depth'));
} else if (cmd === 'map') cmdMap(root);
else if (cmd === 'note') cmdNote(root, found, rest);
else if (cmd === 'stats') cmdStats(root, found);
else if (ROUTE[cmd]) cmdPassthrough(root, found, cmd, rest);
else die(`unknown command "${cmd}"\n\n${HELP}`);
