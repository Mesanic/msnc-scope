// merge.mjs — add the symbol graph's symbol tier to the file graph.
//
// Direction matters. The file graph's viewer is the full-featured one: node-type toggles, git
// state, tag facets, impact mode, flow, search over summaries. It also already reserves
// everything a symbol tier needs -- `sym` in its type/colour/label maps, `y` in its id
// prefixes, `calls` in its edge types -- and never fills them, because the files engine does
// not extract symbols. The symbols engine does. So its symbols go INTO the file graph, and
// the viewer needs no changes to show them.
//
//     mod ◀─part-of── file ◀─part-of── sym ──calls──▶ sym
//     (files)          (files)       (symbols)
//
// The join is the file path: file-graph file nodes carry it in `k`, symbol-graph module nodes in
// `path`, both repo-relative posix. A symbol hangs off the file-graph file node it lives in,
// so the file graph's existing overlays reach it -- a symbol in a modified file sits under a
// modified parent, and the tags that file carries are copied onto the symbol so the tag
// facet keeps working one tier down.

import fs from 'node:fs';
import path from 'node:path';

/** Symbol kinds that are not worth a node of their own in a whole-project picture. */
const SKIP_KINDS = new Set(['module']);

function readJsonl(file, label, die) {
  if (!fs.existsSync(file)) die(`${label} missing (${file})`);
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        return die(`${label} corrupt at line ${i + 1}. Run: scope scan`);
      }
    });
}

/**
 * Fold the symbol graph's symbols into a file graph, in place.
 *
 * @param {{nodes: Map, edges: Map}} fileGraph  as returned by the file graph's loadGraph
 * @returns {object} stats
 */
export function mergeIntoFileGraph({ fileGraph, symbolsDir, die }) {
  const sNodes = readJsonl(path.join(symbolsDir, 'nodes-000.jsonl'), 'symbol nodes', die);
  const sEdges = readJsonl(path.join(symbolsDir, 'edges-000.jsonl'), 'symbol edges', die);

  // --- the join -------------------------------------------------------------
  const fileNodeByPath = new Map();
  for (const n of fileGraph.nodes.values()) {
    // `entry` is the file graph's type for a configured entrypoint. It is a file node in every way
    // that matters here, and matching only `file` silently drops the symbols in exactly
    // the files whose symbols matter most.
    if ((n.t === 'file' || n.t === 'entry') && n.st !== 'dead') fileNodeByPath.set(n.k, n);
  }

  const symId = (id) => 'y' + id.split(':')[1];

  // The file graph keys its edge Map with store.mjs `edgeKey`: tab-separated, not pipe. Building a
  // pipe key here made every `has()` against the file graph's own edges miss, so each file-tier edge
  // both tools knew about was re-added under a second key -- 149 duplicates on axiom-v2.
  const eKey = (a, type, b) => a + '\t' + type + '\t' + b;
  const symbolById = new Map(sNodes.map((n) => [n.id, n]));
  const fileOfModule = new Map(); // symbol-graph module id -> file node
  let unjoined = 0;

  for (const n of sNodes) {
    if (n.kind !== 'module') continue;
    const f = fileNodeByPath.get(n.path);
    if (f) fileOfModule.set(n.id, f);
    else unjoined++;
  }
  // Own the symbol by its own `path`, not by walking `contains` up to a module.
  // `contains` is hierarchical -- a method is contained by its CLASS, not by the file --
  // so a module-parent-only lookup silently drops every method and nested function.
  // Each node already records the file it came from, which is the answer directly.
  const ownerFile = new Map(); // symbol id -> file node
  for (const n of sNodes) {
    if (n.kind === 'module') continue;
    const f = fileNodeByPath.get(n.path);
    if (f) ownerFile.set(n.id, f);
  }

  // --- degree, for node size ------------------------------------------------
  const degree = new Map();
  for (const e of sEdges) {
    if (e.type === 'contains') continue;
    degree.set(e.src, (degree.get(e.src) || 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) || 0) + 1);
  }

  // --- (2) symbol nodes, connected ones only --------------------------------
  // A symbol with no call/heritage/test edge contributes exactly one `part-of` to its
  // file and nothing else. On one repo that was 732 of 1249 symbol nodes -- 59% of the
  // tier -- inflating the picture 3x while carrying no relational information. The file
  // node's `a` anchor list already renders that inventory as text in the inspector, so a
  // leaf symbol duplicates as a dot what the file already says in words.
  //
  // Connected symbols become nodes. Leaves are folded into their file's anchors, which
  // is what `a` is for. Nothing is lost; the graph shows structure instead of inventory.
  const ANCHOR_CAP = 40;
  const fileSymByKey = new Map();
  for (const n of fileGraph.nodes.values()) if (n.t === 'sym') fileSymByKey.set(n.k, n);

  let added = 0;
  let folded = 0;
  let skippedNoFile = 0;
  const extraAnchors = new Map(); // file node -> [[name, line], ...]

  for (const n of sNodes) {
    if (SKIP_KINDS.has(n.kind)) continue;
    const file = ownerFile.get(n.id);
    if (!file) {
      skippedNoFile++;
      continue;
    }
    const key = `${n.path}#${n.name}`;
    // The file graph parses exports into its own sym nodes with this identical key. Enrich that
    // node rather than adding a second dot for the same symbol.
    const existing = fileSymByKey.get(key);
    if (existing) {
      if (!existing.s) existing.s = n.summary || n.sig || '';
      if (!existing.a || !existing.a.length) existing.a = [[n.name, n.span.sl]];
      existing.by = 'symbols';
      continue;
    }
    if (!degree.get(n.id)) {
      if (!extraAnchors.has(file)) extraAnchors.set(file, []);
      extraAnchors.get(file).push([n.name, n.span.sl]);
      folded++;
      continue;
    }
    const id = symId(n.id);
    if (fileGraph.nodes.has(id)) continue;
    fileGraph.nodes.set(id, {
      id,
      t: 'sym',
      k: key,
      s: n.summary || n.sig || '',
      g: [...new Set([...(file.g || []), n.kind, n.lang].filter(Boolean))],
      a: [[n.name, n.span.sl]],
      w: Math.min(6, 1 + (degree.get(n.id) || 0) / 3),
      st: file.st === 'dead' ? 'dead' : null,
      by: 'symbols',
    });
    added++;
  }

  // Merge folded symbols into their file's anchor list, sorted by line so the inspector
  // reads top-to-bottom. Capped: a 200-symbol file would otherwise bury the panel.
  let anchorsTruncated = 0;
  for (const [file, anchors] of extraAnchors) {
    const all = [...(file.a || []), ...anchors].sort((x, y) => x[1] - y[1]);
    if (all.length > ANCHOR_CAP) anchorsTruncated++;
    file.a = all.slice(0, ANCHOR_CAP);
  }

  // --- edges ----------------------------------------------------------------
  // Only types the file graph's viewer already understands; `calls` and `part-of` are both in its
  // EDGE_TYPES, and part-of gets a shorter spring so symbols cluster tight to their file.
  const EDGE_MAP = { call: 'calls', extends: 'implements', implements: 'implements', tests: 'tested-by' };
  const edgeStats = { 'part-of': 0, calls: 0, implements: 0, 'tested-by': 0 };
  const put = (a, type, b) => {
    const key = eKey(a, type, b);
    if (fileGraph.edges.has(key)) return false;
    fileGraph.edges.set(key, [a, type, b]);
    edgeStats[type]++;
    return true;
  };

  for (const [sid, file] of ownerFile) {
    if (fileGraph.nodes.has(symId(sid))) put(symId(sid), 'part-of', file.id);
  }
  for (const e of sEdges) {
    const type = EDGE_MAP[e.type];
    if (!type) continue;
    const a = symId(e.src);
    const b = symId(e.dst);
    if (!fileGraph.nodes.has(a) || !fileGraph.nodes.has(b) || a === b) continue;
    put(a, type, b);
  }

  // --- (1) test coverage ----------------------------------------------------
  // The symbol graph's `tests` edges are module -> module (test FILE -> source FILE), not
  // symbol -> symbol. Routing them through symId dropped every one, which is why the
  // merged graph reported 0 of them while both stores had the data. Route them through
  // fileOfModule like imports, and the file tier gains the test edges the file graph never saw.
  let testsAdded = 0;
  for (const e of sEdges) {
    if (e.type !== 'tests') continue;
    const a = fileOfModule.get(e.src);
    const b = fileOfModule.get(e.dst);
    if (!a || !b || a.id === b.id) continue;
    // The file graph's direction is source --tested-by--> test; the symbol graph's is test --tests--> source.
    const key = eKey(b.id, 'tested-by', a.id);
    if (fileGraph.edges.has(key)) continue;
    fileGraph.edges.set(key, [b.id, 'tested-by', a.id]);
    testsAdded++;
  }

  // --- imports the file graph missed -------------------------------------------------
  // The reverse of the usual cross-check: the symbols engine resolved a file-to-file import that
  // the file graph did not. Rare, but it is free to fold in and it is the same graph either way.
  let importsAdded = 0;
  for (const e of sEdges) {
    if (e.type !== 'import') continue;
    const a = fileOfModule.get(e.src);
    const b = fileOfModule.get(e.dst);
    if (!a || !b || a.id === b.id) continue;
    const key = eKey(a.id, 'imports', b.id);
    if (fileGraph.edges.has(key)) continue;
    fileGraph.edges.set(key, [a.id, 'imports', b.id]);
    importsAdded++;
  }

  // --- (1) connect the concept tier -----------------------------------------
  // Concepts are hand-written domain invariants -- the most expensive knowledge in the
  // repo to rediscover -- and on one project 14 of 17 had ZERO edges: recorded, never
  // linked, so no traversal could ever surface them. Their text is not prose-only; it
  // names issues (#55), symbols (LimitGuard, terminationStands) and files
  // (CONTEXT.md:203). The file graph already parses #N out of issue bodies; concepts never got
  // the same treatment. Extract the same references and the tier joins the graph.
  const conceptStats = { linked: 0, edges: 0, stillIsolated: 0 };
  {
    const issueByNum = new Map();
    const symByName = new Map();
    const fileByBase = new Map();
    for (const n of fileGraph.nodes.values()) {
      if (n.t === 'issue') issueByNum.set(String(n.k).replace(/^#/, ''), n);
      else if (n.t === 'sym') {
        const nm = n.k.split('#')[1];
        // Ambiguous names link nowhere rather than link wrongly.
        if (nm) symByName.set(nm, symByName.has(nm) ? null : n);
      } else if (n.t === 'file' || n.t === 'entry') {
        const b = n.k.split('/').pop();
        if (b) fileByBase.set(b, fileByBase.has(b) ? null : n);
      }
    }
    const degreeOf = new Map();
    for (const e of fileGraph.edges.values()) {
      degreeOf.set(e[0], (degreeOf.get(e[0]) || 0) + 1);
      degreeOf.set(e[2], (degreeOf.get(e[2]) || 0) + 1);
    }
    for (const c of fileGraph.nodes.values()) {
      if (c.t !== 'concept') continue;
      const text = `${c.k} ${c.s || ''}`;
      const targets = new Set();
      for (const m of text.matchAll(/#(\d+)/g)) {
        const t = issueByNum.get(m[1]);
        if (t) targets.add(t.id);
      }
      // A filename with an extension, optionally followed by :line.
      for (const m of text.matchAll(/\b([\w.-]+\.[A-Za-z][\w]*)\b/g)) {
        const t = fileByBase.get(m[1]);
        if (t) targets.add(t.id);
      }
      // Identifiers: CamelCase or camelCase of at least 5 chars. Short/lowercase words
      // are ordinary prose and would link noise.
      for (const m of text.matchAll(/\b([A-Za-z][a-zA-Z0-9]{4,})\b/g)) {
        if (!/[a-z][A-Z]/.test(m[1])) continue;
        const t = symByName.get(m[1]);
        if (t) targets.add(t.id);
      }
      targets.delete(c.id);
      for (const t of targets) {
        const key = eKey(c.id, 'mentions', t);
        if (fileGraph.edges.has(key)) continue;
        fileGraph.edges.set(key, [c.id, 'mentions', t]);
        conceptStats.edges++;
      }
      if (targets.size) conceptStats.linked++;
      else if (!degreeOf.get(c.id)) conceptStats.stillIsolated++;
    }
  }

  // --- (3) make the module tier earn its place ------------------------------
  // `mod` nodes are path prefixes: every node's module is already derivable from its `k`,
  // and moduleDepth slicing produces pass-through links (a dir with no files of its own
  // and a single child) that restate the path twice. Two changes: drop the pass-throughs,
  // and give what remains an aggregate the path cannot carry -- how much code is in it,
  // and how much of that is under test.
  const modStats = { collapsed: 0, enriched: 0 };
  {
    const mods = new Map();
    for (const n of fileGraph.nodes.values()) if (n.t === 'mod') mods.set(n.id, n);
    const childrenOf = new Map();
    const parentOf = new Map();
    for (const e of fileGraph.edges.values()) {
      if (e[1] !== 'part-of' || !mods.has(e[2])) continue;
      if (!childrenOf.has(e[2])) childrenOf.set(e[2], []);
      childrenOf.get(e[2]).push(e[0]);
      parentOf.set(e[0], e[2]);
    }
    for (const [id, mod] of mods) {
      const kids = childrenOf.get(id) || [];
      const files = kids.filter((k) => !mods.has(k));
      const subs = kids.filter((k) => mods.has(k));
      // Pass-through: holds no files itself and forwards to exactly one child module.
      if (files.length === 0 && subs.length === 1) {
        const parent = parentOf.get(id);
        fileGraph.nodes.delete(id);
        for (const [key, e] of [...fileGraph.edges]) {
          if (e[0] !== id && e[2] !== id) continue;
          fileGraph.edges.delete(key);
          if (!parent) continue;
          const a = e[0] === id ? parent : e[0];
          const b = e[2] === id ? parent : e[2];
          if (a !== b) fileGraph.edges.set(eKey(a, e[1], b), [a, e[1], b]);
        }
        modStats.collapsed++;
        continue;
      }
      // Aggregate: files, symbols underneath them, and the tested fraction.
      let syms = 0;
      let tested = 0;
      for (const f of files) {
        const fn = fileGraph.nodes.get(f);
        if (!fn) continue;
        syms += (fn.a || []).length;
        for (const e of fileGraph.edges.values()) {
          if (e[1] === 'tested-by' && e[0] === f) { tested++; break; }
        }
      }
      mod.s = `${files.length} files · ${syms} symbols · ${files.length ? Math.round((tested / files.length) * 100) : 0}% have tests`;
      mod.w = Math.min(8, 1 + files.length / 4);
      modStats.enriched++;
    }
  }

  // --- (2) provenance -------------------------------------------------------
  // Which tool knows this node? The whole reason Scope exists is that the two stores
  // disagree, and until now that was invisible in the picture: every merged node just
  // said "symbols" and every file-graph node said "scan". Marking the JOIN explicitly gives
  // the viewer a third answer -- `both` -- and makes "what does only one tool see?" a
  // question the graph can answer.
  const joinedIds = new Set([...fileOfModule.values()].map((f) => f.id));
  const provenance = { files: 0, symbols: 0, both: 0 };
  for (const n of fileGraph.nodes.values()) {
    if (n.t === 'sym' && n.by === 'symbols') n.src = 'symbols';
    else if (joinedIds.has(n.id)) n.src = 'both';
    else n.src = 'files';
    provenance[n.src]++;
  }

  // --- (4) check lens -------------------------------------------------------
  // `scope check` writes drift/dangling/orphans/ambiguous to check-latest.json. The symbol graph's
  // own viewer had a Change Lens tab for it; the file graph's viewer has no concept of it, so
  // folding the state onto nodes is what lets the existing facet machinery show it.
  // Entries do not share one shape, hence pathOf.
  const check = readCheckLatest(symbolsDir);
  const checkCounts = { drift: 0, dangling: 0, orphan: 0, ambiguous: 0 };
  if (check) {
    const byPath = new Map();
    for (const n of fileGraph.nodes.values()) {
      const p = n.t === 'sym' ? n.k.split('#')[0] : n.k;
      if (!byPath.has(p)) byPath.set(p, []);
      byPath.get(p).push(n);
    }
    // Worst state wins, so a file that both drifted and holds an orphan note reads as
    // drifted -- the more urgent fact.
    const RANK = { drift: 3, dangling: 2, orphan: 1, ambiguous: 1 };
    const flag = (p, state) => {
      for (const n of byPath.get(p) || []) {
        if (n.chk && RANK[n.chk] >= RANK[state]) continue;
        if (n.chk) checkCounts[n.chk]--;
        n.chk = state;
        checkCounts[state]++;
      }
    };
    const pathOf = (e) => e?.path || e?.sp || e?.ref?.path || e?.from?.path || null;
    for (const [key, state] of [['drift', 'drift'], ['dangling', 'dangling'], ['orphans', 'orphan'], ['ambiguous', 'ambiguous']]) {
      for (const e of check[key] || []) {
        const p = pathOf(e);
        if (p) flag(p, state);
      }
    }
  }

  // --- (5) notes ------------------------------------------------------------
  // The symbol graph's ledger is the most durable knowledge in either store -- notes are anchored
  // to a source hash, so they survive a symbol moving. They never reached the graph.
  // Last record per key wins, matching how the symbols engine itself reads the ledger.
  const notes = readLedgerNotes(symbolsDir, die);
  const orphanKeys = new Set((check?.orphans || []).map((o) => o.key).filter(Boolean));
  let notesAttached = 0;
  let notesStale = 0;
  if (notes.size) {
    const byPathSpan = new Map();
    for (const n of fileGraph.nodes.values()) {
      if (n.t === 'sym' && n.a && n.a.length) byPathSpan.set(`${n.k}`, n);
    }
    for (const note of notes.values()) {
      if (!note.path || !note.name) continue;
      const target = byPathSpan.get(`${note.path}#${note.name}`);
      if (!target) continue;
      // A note whose source hash no longer matches is an ORPHAN in the symbol graph's terms: it
      // still describes this symbol by name, but the symbols engine has not re-bound it and will
      // not until `check` rebinds. Show it, say it is unverified -- hiding it loses real
      // knowledge, presenting it as bound would overstate what the symbols engine actually asserts.
      const stale = orphanKeys.has(note.key);
      target.note = stale ? `(unbound — the code changed since this was written) ${note.text}` : note.text;
      target.g = [...new Set([...(target.g || []), stale ? 'stale-note' : 'has-note'])];
      if (stale) notesStale++;
      notesAttached++;
    }
  }

  return {
    symbols: added,
    foldedLeaves: folded,
    anchorsTruncated,
    concepts: conceptStats,
    mods: modStats,
    joinedFiles: fileOfModule.size,
    unjoinedModules: unjoined,
    skippedNoFile,
    edges: edgeStats,
    importsAdded,
    testsAdded,
    provenance,
    check: check ? { ...checkCounts, ran: true } : { ran: false },
    notesAttached,
    notesStale,
    symbolNodes: symbolById.size,
  };
}

/** `scope check` output. Absent or corrupt = no lens; never a hard failure. */
function readCheckLatest(symbolsDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(symbolsDir, 'check-latest.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Ledger notes keyed by note key; append-only file, last record per key wins. */
function readLedgerNotes(symbolsDir, die) {
  const p = path.join(path.dirname(symbolsDir), 'ledger', 'notes.jsonl');
  if (!fs.existsSync(p)) return new Map();
  const out = new Map();
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      die(`symbol ledger corrupt at notes.jsonl:${i + 1}`);
    }
    if (rec.kind !== 'symbol' || !rec.key) continue;
    if (rec.op === 'del') out.delete(rec.key);
    else out.set(rec.key, rec);
  }
  return out;
}
