import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EDGES_SEGMENT,
  FACTS_SEGMENT,
  NODES_SEGMENT,
  SCHEMA_VERSION,
  TOOL_ID,
  readMeta,
  readSegment,
  storeDirFor,
} from './store.mjs';
import { buildStore, loadQueryStore, moduleIdOfNode } from './query-store.mjs';
import { collectImpact } from './impact.mjs';
import { CHECK_BUDGET_TOKENS, CHECK_HINT_RESERVE_TOKENS, CHECK_TRUNCATION_SUFFIX, estimateTokens } from './tokens.mjs';
import { atomicWriteFile, cmpStr, contentHash, toPosix } from './util.mjs';
import { walkSourceFiles } from './walk.mjs';
import { detectRunners } from './runners.mjs';
import {
  appendNoteRecords,
  computeSourceKeys,
  displayKey,
  latestByKey,
  readNotes,
  rebindEdgeRecord,
  rebindSymbolRecord,
} from './ledger.mjs';

export { CHECK_BUDGET_TOKENS, CHECK_HINT_RESERVE_TOKENS, CHECK_TRUNCATION_SUFFIX };

/**
 * `scope check` — post-edit verification (M3).
 *
 * Pipeline:
 *   1. snapshot the PRE-resync state (meta + segments) — this is the baseline
 *      the working tree is diffed against;
 *   2. classify dirty files by hashing current bytes vs the recorded hashes;
 *   3. auto-resync the index (incremental scan) so answers come from the
 *      current tree;
 *   4. drift: exported symbols whose signature hash changed -> stale
 *      dependents listed from the impact graph (spans + per-edge confidence),
 *      grouped by importing module;
 *   5. dangling: call/import edges from the old graph whose target symbol or
 *      module vanished (suppressed when the source demonstrably follows a
 *      same-named replacement in the new graph);
 *   6. ledger notes rebound by symbol-source hash (moves survive; identical
 *      bodies collide loudly; unmatchable notes are orphans);
 *   7. test map: detected runners + test files covering affected modules.
 *
 * Exit discipline lives in the CLI: issues > 0 => exit 1 until clean.
 */

const DANGLING_EDGE_TYPES = Object.freeze(['call', 'import']);
const HEAL_CHECK_TYPES = Object.freeze(['call', 'import', 'route', 'extends', 'implements']);
const STRENGTH = { exact: 2, heuristic: 1 };

/**
 * Volatile derived check state: a compact machine-readable summary of the
 * latest `scope check` report, persisted to `.scope/symbols/index/check-latest.json`.
 * It is the Change-Lens data source for `scope view`; it lives inside
 * `.scope/symbols/index/` (gitignored by `init`) and is regenerated on every run —
 * never golden-snapshotted, never hand-edited.
 */
export const CHECK_LATEST_FILE = 'check-latest.json';
export const CHECK_LATEST_V = 1;

export function checkLatestPathFor(projectRoot) {
  return path.join(storeDirFor(path.resolve(projectRoot)), CHECK_LATEST_FILE);
}

/** Fixed-key-order projection of a report for persistence (deterministic bytes). */
export function checkStateFromReport(report) {
  return {
    v: CHECK_LATEST_V,
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    root: report.root,
    issues: report.issues,
    counts: report.counts,
    dirty: report.dirty,
    drift: report.drift,
    dangling: report.dangling,
    orphans: report.orphans,
    ambiguous: report.ambiguous,
    rebindings: report.rebindings,
    runners: report.runners,
    runnerSources: report.runnerSources,
    tests: report.tests,
  };
}

export async function persistCheckLatest(rootAbs, report) {
  await atomicWriteFile(checkLatestPathFor(rootAbs), `${JSON.stringify(checkStateFromReport(report))}\n`);
}

/**
 * Load the persisted check summary for the Change Lens. Missing or malformed
 * files yield null (the viewer renders Graph/Flow only) — this file is purely
 * advisory derived state; a corrupt file is reported as absent, never fatal.
 */
export async function readCheckLatest(projectRoot) {
  let raw;
  try {
    raw = await readFile(checkLatestPathFor(projectRoot), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.v !== CHECK_LATEST_V) return null;
    if (typeof parsed.schemaVersion !== 'number' || typeof parsed.issues !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function confRank(conf) {
  return -(STRENGTH[conf] ?? 1);
}

function slimNode(node) {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    path: node.path,
    sl: node.span.sl,
    el: node.span.el,
    confidence: node.confidence,
  };
}

async function readSegmentSoft(absPath) {
  try {
    return await readSegment(absPath);
  } catch (err) {
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

function defsByName(factsRec) {
  const map = new Map();
  for (const def of factsRec?.facts?.defs ?? []) {
    if (!map.has(def.name)) map.set(def.name, []);
    map.get(def.name).push(def);
  }
  return map;
}

function sigHashSet(defs) {
  return [...new Set(defs.map((d) => String(d.sigHash ?? '')))].sort(cmpStr).join(',');
}

function mergeDependents(impact) {
  const seen = new Map();
  for (const item of [...impact.direct, ...impact.transitive]) {
    const prev = seen.get(item.node.id);
    if (!prev || (confRank(item.confidence) < confRank(prev.confidence))) {
      seen.set(item.node.id, item);
    }
  }
  return [...seen.values()]
    .map(({ node, confidence }) => ({ ...slimNode(node), confidence, module: moduleIdOfNode(node) }))
    .sort(
      (a, b) =>
        confRank(a.confidence) - confRank(b.confidence) ||
        cmpStr(a.path, b.path) ||
        a.sl - b.sl ||
        cmpStr(a.id, b.id),
    );
}

/**
 * Dangling references: old-graph call/import edges aimed at symbols/modules
 * that no longer exist under their dirty paths. A reference is "healed" when
 * its source now has an edge of the same family pointing at a live node with
 * the removed symbol's name (rename followed through). Exported pure so the
 * suppression rule stays unit-testable without fixture files.
 */
export function findDangling(oldStore, newStore, dirtyPaths) {
  const namesByPathNew = new Map();
  for (const n of newStore.nodes) {
    if (!namesByPathNew.has(n.path)) namesByPathNew.set(n.path, new Set());
    namesByPathNew.get(n.path).add(n.name);
  }

  function isHealed(srcId, removedName) {
    for (const e of newStore.adjOut.get(srcId) ?? []) {
      if (!HEAL_CHECK_TYPES.includes(e.type)) continue;
      const dst = newStore.nodesById.get(e.dst);
      if (dst && dst.name === removedName) return true;
    }
    return false;
  }

  const dangling = [];
  for (const oldNode of oldStore.nodes) {
    if (!dirtyPaths.has(oldNode.path)) continue;
    const liveNames = namesByPathNew.get(oldNode.path);
    if (liveNames && liveNames.has(oldNode.name)) continue;
    const seen = new Set();
    for (const e of oldStore.adjIn.get(oldNode.id) ?? []) {
      if (!DANGLING_EDGE_TYPES.includes(e.type)) continue;
      const dedup = `${e.src}|${e.type}|${oldNode.name}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      if (isHealed(e.src, oldNode.name)) continue;
      const srcNew = newStore.nodesById.get(e.src);
      dangling.push({
        type: e.type,
        confidence: e.confidence,
        target: { name: oldNode.name, id: oldNode.id, path: oldNode.path },
        source: srcNew
          ? slimNode(srcNew)
          : { id: e.src, name: null, kind: null, path: null, sl: null, el: null, confidence: null },
      });
    }
  }
  dangling.sort(
    (a, b) =>
      cmpStr(a.source.path ?? '', b.source.path ?? '') ||
      (a.source.sl ?? 0) - (b.source.sl ?? 0) ||
      cmpStr(a.type, b.type) ||
      cmpStr(a.target.name, b.target.name) ||
      cmpStr(a.target.id, b.target.id),
  );
  return dangling;
}

function collectAffectedTests(store, affectedModuleIds) {
  const best = new Map();
  for (const e of store.edges) {
    if (e.type !== 'tests') continue;
    const dst = store.nodesById.get(e.dst);
    if (!dst || !affectedModuleIds.has(dst.name)) continue;
    const src = store.nodesById.get(e.src);
    if (!src) continue;
    const prev = best.get(src.path);
    if (!prev || (prev !== 'exact' && e.confidence === 'exact')) best.set(src.path, e.confidence);
  }
  return [...best.entries()]
    .map(([testPath, confidence]) => ({ path: testPath, confidence }))
    .sort((a, b) => confRank(a.confidence) - confRank(b.confidence) || cmpStr(a.path, b.path));
}

function noteRef(rec) {
  const base = { key: rec.key, kind: rec.kind === 'edge' ? 'edge' : 'symbol', text: typeof rec.text === 'string' ? rec.text : '' };
  if (rec.kind === 'edge') {
    return {
      ...base,
      ref: {
        nodeId: rec.fromNodeId && rec.toNodeId ? `${rec.fromNodeId}->${rec.toNodeId}` : null,
        path: rec.fromPath ?? null,
        sl: rec.fromSpan?.sl ?? null,
        el: rec.fromSpan?.el ?? null,
      },
    };
  }
  return {
    ...base,
    ref: {
      nodeId: rec.nodeId ?? null,
      path: rec.path ?? null,
      sl: rec.span?.sl ?? null,
      el: rec.span?.el ?? null,
    },
  };
}

/**
 * Collect the full check report. Never prints; returns a plain deterministic
 * object. `deps.query.scanImpl` injects the scanner for tests;
 * `deps.applyRebinds: false` skips ledger mutation (used by dry-run callers).
 */
export async function collectCheckReport(rootAbs, deps = {}) {
  const root = path.resolve(rootAbs);
  const dir = storeDirFor(root);

  // 1. Baseline snapshot BEFORE resync overwrites the segments.
  const preMetaState = await readMeta(dir);
  const preMeta = preMetaState.status === 'ok' ? preMetaState.meta : null;
  const [oldNodes, oldEdges, oldFactsRecords] = await Promise.all([
    readSegmentSoft(path.join(dir, NODES_SEGMENT)),
    readSegmentSoft(path.join(dir, EDGES_SEGMENT)),
    readSegmentSoft(path.join(dir, FACTS_SEGMENT)),
  ]);
  const oldStore = buildStore(oldNodes, oldEdges);
  const oldFactsByPath = new Map(oldFactsRecords.filter((r) => r._ === 'facts').map((r) => [r.path, r]));

  // 2. Dirty classification by content hash.
  const dirtyEdited = [];
  const dirtyDeleted = [];
  let addedCount = 0;
  if (preMeta) {
    const walked = await walkSourceFiles(root);
    const walkedSet = new Set(walked.map((w) => w.posixPath));
    const priorPaths = Object.keys(preMeta.files ?? {}).sort(cmpStr);
    const priorSet = new Set(priorPaths);
    for (const p of priorPaths) {
      if (!walkedSet.has(p)) {
        dirtyDeleted.push(p);
        continue;
      }
      let currentHash = '';
      try {
        currentHash = contentHash(await readFile(path.join(root, ...p.split('/')), 'utf8'));
      } catch {
        dirtyDeleted.push(p);
        continue;
      }
      if (currentHash !== preMeta.files?.[p]?.hash) dirtyEdited.push(p);
    }
    addedCount = walked.filter((w) => !priorSet.has(w.posixPath)).length;
  }

  // 3. Resync so everything below reflects the tree as it is NOW.
  const store = await loadQueryStore(root, deps.query ?? {});
  const freshFactsRecords = await readSegmentSoft(path.join(dir, FACTS_SEGMENT));
  const newFactsByPath = new Map(freshFactsRecords.filter((r) => r._ === 'facts').map((r) => [r.path, r]));

  // 4. Drift on edited files.
  const drift = [];
  for (const p of dirtyEdited) {
    const oldDefs = defsByName(oldFactsByPath.get(p));
    const newDefs = defsByName(newFactsByPath.get(p));
    for (const name of [...oldDefs.keys()].filter((n) => newDefs.has(n)).sort(cmpStr)) {
      const o = oldDefs.get(name);
      const nw = newDefs.get(name);
      if (sigHashSet(o) === sigHashSet(nw)) continue;
      const newNode = store.nodes.find(
        (nd) => nd.path === p && nd.name === name && nd.exported && nd.kind !== 'module',
      );
      if (!newNode) continue;
      const impact = collectImpact(store, newNode.id, 'up');
      drift.push({
        path: p,
        name,
        oldSigHash: String(o[0]?.sigHash ?? ''),
        newSigHash: String(nw[0]?.sigHash ?? ''),
        node: slimNode(newNode),
        dependents: mergeDependents(impact),
      });
    }
  }
  drift.sort((a, b) => cmpStr(a.path, b.path) || cmpStr(a.name, b.name));

  // 5. Dangling references from removed symbols/modules.
  const dangling = findDangling(oldStore, store, new Set([...dirtyEdited, ...dirtyDeleted]));

  // 6. Ledger: rebind / orphan / ambiguous classification (+ persistence).
  const records = await readNotes(root);
  const latest = latestByKey(records);
  const rebindings = [];
  const orphans = [];
  const ambiguous = [];
  const toAppend = [];
  if (latest.size > 0) {
    const { keyByNode, nodesByKey } = await computeSourceKeys(root, store);
    const endpointStatus = (rec, prefix) => {
      const nodeId = rec[`${prefix}NodeId`];
      const key = rec[`${prefix}Key`];
      const bound = nodeId ? store.nodesById.get(nodeId) : null;
      if (bound && keyByNode.get(bound.id) === key) return { status: 'bound', node: bound };
      const candidates = nodesByKey.get(key) ?? [];
      if (candidates.length === 1) return { status: 'rebind', node: candidates[0] };
      if (candidates.length === 0) return { status: 'orphan' };
      return { status: 'ambiguous', candidates };
    };
    for (const [key, rec] of [...latest.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
      if (rec.kind !== 'edge') {
        const bound = rec.nodeId ? store.nodesById.get(rec.nodeId) : null;
        if (bound && keyByNode.get(bound.id) === key) continue;
        const candidates = nodesByKey.get(key) ?? [];
        if (candidates.length === 1) {
          rebindings.push({
            key,
            fromNodeId: rec.nodeId ?? null,
            toNodeId: candidates[0].id,
            fromPath: rec.path ?? null,
            toPath: candidates[0].path,
          });
          toAppend.push(rebindSymbolRecord(rec, candidates[0]));
        } else if (candidates.length === 0) {
          orphans.push(noteRef(rec));
        } else {
          ambiguous.push({ key, candidates: candidates.map(slimNode) });
        }
        continue;
      }
      const fromR = endpointStatus(rec, 'from');
      const toR = endpointStatus(rec, 'to');
      if (fromR.status === 'ambiguous' || toR.status === 'ambiguous') {
        ambiguous.push({
          key,
          candidates: [...(fromR.candidates ?? []), ...(toR.candidates ?? [])].map(slimNode),
        });
        continue;
      }
      if (fromR.status === 'orphan' || toR.status === 'orphan') {
        orphans.push(noteRef(rec));
        continue;
      }
      if (fromR.status === 'rebind' || toR.status === 'rebind') {
        rebindings.push({
          key,
          fromNodeId: fromR.node?.id ?? rec.fromNodeId ?? null,
          toNodeId: toR.node?.id ?? rec.toNodeId ?? null,
          fromPath: fromR.node?.path ?? rec.fromPath ?? null,
          toPath: toR.node?.path ?? rec.toPath ?? null,
        });
        toAppend.push(
          rebindEdgeRecord(rec, {
            fromNode: fromR.status === 'rebind' ? fromR.node : null,
            toNode: toR.status === 'rebind' ? toR.node : null,
          }),
        );
      }
    }
  }
  if (toAppend.length > 0 && deps.applyRebinds !== false) {
    await appendNoteRecords(root, toAppend);
  }

  // 7. Runner detection + affected-test mapping.
  const runners = deps.detectRunners ? await deps.detectRunners(root) : await detectRunners(root);
  const langByPath = new Map();
  for (const n of store.nodes) if (!langByPath.has(n.path)) langByPath.set(n.path, n.lang);
  const affectedModules = new Set();
  const addModule = (p) => {
    if (!p) return;
    affectedModules.add(moduleIdOfNode({ path: p, lang: langByPath.get(p) ?? 'typescript' }));
  };
  for (const d of drift) addModule(d.node.path);
  for (const g of dangling) {
    addModule(g.source.path);
    addModule(g.target.path);
  }
  const tests = collectAffectedTests(store, affectedModules);

  const counts = {
    drift: drift.length,
    dangling: dangling.length,
    orphans: orphans.length,
    ambiguous: ambiguous.length,
    rebindings: rebindings.length,
  };
  const report = {
    v: 1,
    root: toPosix(root),
    issues: counts.drift + counts.dangling + counts.orphans + counts.ambiguous,
    counts,
    dirty: { edited: [...dirtyEdited].sort(cmpStr), deleted: [...dirtyDeleted].sort(cmpStr), added: addedCount },
    drift,
    dangling,
    orphans,
    ambiguous,
    rebindings,
    runners: runners.map((r) => r.id),
    runnerSources: Object.fromEntries(runners.map((r) => [r.id, r.source])),
    tests,
  };
  // Persist the Change-Lens summary (volatile derived state; opt-out for
  // purity-sensitive callers). A failed write is a real failure — surface it.
  if (deps.persistCheckState !== false) await persistCheckLatest(root, report);
  return report;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function refTail(ref) {
  const parts = [ref.nodeId ?? '?', ref.path ?? '?'];
  if (ref.sl !== null && ref.sl !== undefined) parts.push(`${ref.sl}-${ref.el ?? ref.sl}`);
  return parts.join(' ');
}

/**
 * Human report under a hard token budget (same greedy fill + explicit
 * truncation-hint contract as the impact assembler).
 */
export function formatCheckReportHuman(report, budgetTokens = CHECK_BUDGET_TOKENS) {
  const c = report.counts;
  if (report.issues === 0 && c.rebindings === 0) return 'check: clean';

  const header =
    report.issues === 0
      ? `check: clean (${c.rebindings} rebound)`
      : `check: ${report.issues} issue${report.issues === 1 ? '' : 's'} (drift ${c.drift}, dangling ${c.dangling}, orphans ${c.orphans}, ambiguous ${c.ambiguous})`;

  const sections = [];

  if (report.drift.length > 0) {
    const lines = [];
    let driftPending = 0;
    for (const d of report.drift) {
      lines.push({ text: `  exact ${d.node.id} ${d.node.name} ${d.node.path}:${d.node.sl}-${d.node.el}`, isItem: true });
      driftPending += 1;
      if (d.dependents.length > 0) {
        lines.push({ text: `    stale dependents (${d.dependents.length}, by module):`, isItem: false });
        const byModule = new Map();
        for (const dep of d.dependents) {
          if (!byModule.has(dep.module)) byModule.set(dep.module, []);
          byModule.get(dep.module).push(dep);
        }
        for (const [moduleId, deps] of [...byModule.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
          lines.push({ text: `      ${moduleId} (${deps.length}):`, isItem: false });
          for (const dep of deps) {
            lines.push({
              text: `        ${dep.confidence} ${dep.id} ${dep.name} ${dep.path}:${dep.sl}-${dep.el}`,
              isItem: true,
            });
            driftPending += 1;
          }
        }
      } else {
        lines.push({ text: '    stale dependents (0)', isItem: false });
      }
    }
    sections.push({ title: `drift (${report.drift.length})`, lines, pending: driftPending });
  }

  if (report.dangling.length > 0) {
    const lines = report.dangling.map((g) => ({
      text:
        `  ${g.type} ${g.confidence} ${g.source.name ?? g.source.id}` +
        `${g.source.path ? ` ${g.source.path}:${g.source.sl}-${g.source.el}` : ''}` +
        ` -> ${g.target.name} (removed ${g.target.id})`,
      isItem: true,
    }));
    sections.push({ title: `dangling (${report.dangling.length})`, lines, pending: report.dangling.length });
  }

  if (report.orphans.length > 0) {
    const lines = report.orphans.map((o) => ({
      text: `  ${displayKey(o.key)} "${clip(o.text, 40)}" (was ${refTail(o.ref)})`,
      isItem: true,
    }));
    sections.push({ title: `orphans (${report.orphans.length})`, lines, pending: report.orphans.length });
  }

  if (report.ambiguous.length > 0) {
    const lines = [];
    let ambiguousPending = 0;
    for (const a of report.ambiguous) {
      lines.push({ text: `  ${displayKey(a.key)}: ${a.candidates.length} identical candidates:`, isItem: true });
      ambiguousPending += 1;
      for (const cand of a.candidates) {
        lines.push({ text: `    ${cand.id} ${cand.path}:${cand.sl}-${cand.el}`, isItem: true });
        ambiguousPending += 1;
      }
    }
    sections.push({ title: `ambiguous (${report.ambiguous.length})`, lines, pending: ambiguousPending });
  }

  if (report.rebindings.length > 0) {
    const lines = report.rebindings.map((r) => ({
      text: `  ${displayKey(r.key)}: ${r.fromNodeId ?? '?'} -> ${r.toNodeId}${r.fromPath ? ` (${r.fromPath} -> ${r.toPath})` : ''}`,
      isItem: true,
    }));
    sections.push({ title: `rebindings (${report.rebindings.length})`, lines, pending: report.rebindings.length });
  }

  if (report.tests.length > 0 || report.runners.length > 0) {
    const lines = report.tests.map((t) => ({ text: `  ${t.confidence} ${t.path}`, isItem: true }));
    sections.push({
      title: `tests (runners: ${report.runners.length > 0 ? report.runners.join(', ') : 'none'})`,
      lines,
      pending: report.tests.length,
    });
  }

  const limit = budgetTokens - CHECK_HINT_RESERVE_TOKENS;
  let out = header;
  let skipped = 0;
  for (const section of sections) {
    if (section.lines.length === 0) continue;
    let candidate = `${out}\n${section.title}`;
    if (estimateTokens(candidate) > limit) {
      skipped += section.pending;
      continue;
    }
    let shownItems = 0;
    for (const line of section.lines) {
      const attempt = `${candidate}\n${line.text}`;
      if (estimateTokens(attempt) > limit) break;
      candidate = attempt;
      if (line.isItem) shownItems += 1;
    }
    skipped += section.pending - shownItems;
    out = candidate;
  }

  if (skipped > 0) {
    const hint = `\n+${skipped} ${CHECK_TRUNCATION_SUFFIX}`;
    if (estimateTokens(out + hint) <= budgetTokens) out += hint;
    else {
      let lines = out.split('\n');
      while (lines.length > 0 && estimateTokens(lines.join('\n') + hint) > budgetTokens) lines.pop();
      out = lines.join('\n') + hint;
    }
  }
  return out;
}

/** Machine-readable report: full fidelity, never truncated, fixed key order. */
export function formatCheckReportJson(report) {
  return JSON.stringify(report);
}
