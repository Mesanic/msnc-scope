import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  EDGES_SEGMENT,
  SYMBOLS_DIRNAME,
  NODES_SEGMENT,
  IndexVersionError,
  SCHEMA_VERSION,
  TOOL_ID,
  readMeta,
  readSegment,
  storeDirFor,
} from './store.mjs';
import { IncompleteIndexError, StoreCorruptError } from './query-store.mjs';
import { atomicWriteFile, cmpStr, toPosix } from './util.mjs';
import { CHECK_LATEST_V, readCheckLatest } from './check.mjs';
import { latestByKey, readNotes } from './ledger.mjs';

/**
 * `scope view` (M5) — emit ONE self-contained offline HTML viewer.
 *
 * Hard bounds & honesty rules:
 *   - total file size ≤ VIEWER_MAX_TOTAL_BYTES (embedded data included);
 *     when the graph does not fit, a deterministic top-N cut (degree desc,
 *     then span size, then id) keeps the most connected symbols and the UI
 *     shows an explicit truncation banner with exact shown/total counts.
 *   - zero external references (no CDN/fonts/images/fetch) — opens from
 *     file:// offline; asserted by findNetworkRefs + tests.
 *   - deterministic bytes: sorted iteration everywhere, no timestamps in the
 *     HTML (unlike meta.json, this artifact has NO volatile fields).
 */

/** 1.5 MB interpreted conservatively as decimal bytes. */
export const VIEWER_MAX_TOTAL_BYTES = 1_500_000;
/** Headroom between the embedded-data budget and the hard total-file cap. */
export const VIEW_DATA_SAFETY_MARGIN = 4_096;
/** Generated artifact filename under `<root>/.scope/symbols/` (design doc §4). */
export const VIEW_OUTPUT_FILE = 'view-data.html';
/** Payload schema version of the embedded data island. */
export const VIEW_PAYLOAD_V = 1;

const TEMPLATE_URL = new URL('./view.template.html', import.meta.url);
const DATA_TOKEN = '__SCOPE_SYMBOLS_PAYLOAD__';

/**
 * Network-reference detectors applied to the generated HTML. Exported so the
 * tests can use them and negative-control them with planted references.
 * NOTE: the viewer template must never trip these (no src=/href= attributes,
 * no dynamic import(), no URL strings — including SVG xmlns declarations).
 */
export const NETWORK_REF_PATTERNS = Object.freeze([
  /\bhttps?:\/\//i,
  /\bsrc\s*=/i,
  /\bhref\s*=/i,
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /\bimport\s*\(/,
  /\bimportScripts\b/,
  /\bWebSocket\b/,
  /\bsendBeacon\b/,
  /\bEventSource\b/,
]);

export function findNetworkRefs(text) {
  return NETWORK_REF_PATTERNS.filter((re) => re.test(text)).map((re) => String(re));
}

let templateCache = null;

async function loadTemplate() {
  if (templateCache === null) {
    const tpl = await readFile(TEMPLATE_URL, 'utf8');
    const hits = tpl.split(DATA_TOKEN).length - 1;
    if (hits !== 1) throw new Error(`viewer template must contain exactly one ${DATA_TOKEN} token (found ${hits})`);
    templateCache = tpl;
  }
  return templateCache;
}

/** Compact fixed-key-order node projection for the embedded data island. */
export function compactNodeRecord(nd) {
  return {
    i: nd.id,
    k: nd.kind,
    n: nd.name,
    p: nd.path,
    c: nd.confidence,
    l: [nd.span.sl, nd.span.el],
    g: typeof nd.sig === 'string' ? nd.sig : '',
  };
}

/** Compact fixed-key-order edge projection for the embedded data island. */
export function compactEdgeRecord(e) {
  return { s: e.src, d: e.dst, t: e.type, c: e.confidence };
}

function jsonLen(value) {
  // +1 accounts for the joining comma inside the serialized JSON array.
  return JSON.stringify(value).length + 1;
}

function edgeKey(e) {
  return `${e.src}|${e.dst}|${e.type}|${e.confidence}`;
}

function isEntrypoint(nd) {
  // Route handlers are first-class entrypoints; a *symbol* named main is one
  // too — but not a module/package merely named "main" (e.g. Go package main).
  return nd.kind === 'route' || (nd.name === 'main' && nd.kind !== 'module');
}

/** Share of the data budget reserved for nodes before edges claim their turn. */
const NODE_BUDGET_SHARE = 0.62;

/**
 * Deterministic bounded selection.
 *
 * Phase A ranks nodes by degree desc, then span size desc, then id asc and
 * greedily fills up to NODE_BUDGET_SHARE of the budget (so relations keep
 * headroom — a node-only payload would render as disconnected dots).
 * Phase B adds both-endpoint edges (hub-first), then route/test edges that
 * pull their missing counterpart in. Phase C backfills any unused budget
 * with the next ranked nodes. Every exclusion is counted, never silent.
 *
 * Returns compact island-ready arrays plus exact shown/total accounting and
 * the exact serialized byte cost of the selected node+edge arrays.
 */
export function selectBoundedView(nodeRecords, edgeRecords, dataBudgetBytes) {
  const degree = new Map();
  const nodeById = new Map();
  for (const nd of nodeRecords) {
    degree.set(nd.id, 0);
    nodeById.set(nd.id, nd);
  }
  const validEdges = edgeRecords.filter((e) => nodeById.has(e.src) && nodeById.has(e.dst));
  for (const e of validEdges) {
    degree.set(e.src, degree.get(e.src) + 1);
    degree.set(e.dst, degree.get(e.dst) + 1);
  }

  const spanSize = (nd) => Math.max(0, nd.span.el - nd.span.sl);
  const ranked = [...nodeRecords].sort(
    (a, b) => degree.get(b.id) - degree.get(a.id) || spanSize(b) - spanSize(a) || cmpStr(a.id, b.id),
  );

  let used = 0;
  let rankPos = 0;
  const selectedIds = new Set();
  const selected = [];

  function takeRankedNodes(ceiling) {
    while (rankPos < ranked.length) {
      const cost = jsonLen(compactNodeRecord(ranked[rankPos]));
      if (used + cost > ceiling) break;
      used += cost;
      selected.push(ranked[rankPos]);
      selectedIds.add(ranked[rankPos].id);
      rankPos++;
    }
  }

  takeRankedNodes(dataBudgetBytes * NODE_BUDGET_SHARE);

  const directEdges = [];
  const pullable = [];
  for (const e of validEdges) {
    const sIn = selectedIds.has(e.src);
    const dIn = selectedIds.has(e.dst);
    if (sIn && dIn) directEdges.push(e);
    else if ((e.type === 'route' || e.type === 'tests') && (sIn || dIn)) pullable.push(e);
  }
  const hubWeight = (e) => -(degree.get(e.src) + degree.get(e.dst));
  // Hub-first keeps the surviving cut structurally meaningful; the key
  // tiebreak makes it deterministic.
  directEdges.sort((a, b) => hubWeight(a) - hubWeight(b) || cmpStr(edgeKey(a), edgeKey(b)));
  pullable.sort((a, b) => cmpStr(edgeKey(a), edgeKey(b)));

  const keptDirect = [];
  for (const e of directEdges) {
    const cost = jsonLen(compactEdgeRecord(e));
    if (used + cost > dataBudgetBytes) break;
    used += cost;
    keptDirect.push(e);
  }

  const pulledIds = new Set();
  const keptPulledEdges = [];
  for (const e of pullable) {
    const missingId = selectedIds.has(e.src) ? e.dst : e.src;
    const missing = nodeById.get(missingId);
    if (!missing) continue;
    let cost = jsonLen(compactEdgeRecord(e));
    if (!pulledIds.has(missingId)) cost += jsonLen(compactNodeRecord(missing));
    if (used + cost > dataBudgetBytes) continue;
    used += cost;
    pulledIds.add(missingId);
    keptPulledEdges.push(e);
  }
  keptPulledEdges.sort((a, b) => cmpStr(edgeKey(a), edgeKey(b)));

  // Backfill: if edges left budget unused, spend it on more ranked nodes.
  takeRankedNodes(dataBudgetBytes);

  const allSelected = [...selected, ...[...pulledIds].map((id) => nodeById.get(id))];
  const nodesCompact = allSelected.map(compactNodeRecord).sort((a, b) => cmpStr(a.i, b.i));
  const allKeptEdges = [...keptDirect, ...keptPulledEdges].sort((a, b) => cmpStr(edgeKey(a), edgeKey(b)));
  const edgesCompact = allKeptEdges.map(compactEdgeRecord);

  const shownNodes = allSelected.length;
  const shownEdges = keptDirect.length + keptPulledEdges.length;
  return {
    nodesCompact,
    edgesCompact,
    entrypoints: allSelected
      .filter(isEntrypoint)
      .sort((a, b) => cmpStr(a.name, b.name) || cmpStr(a.id, b.id))
      .map((nd) => nd.id),
    totalNodes: nodeRecords.length,
    totalEdges: edgeRecords.length,
    shownNodes,
    shownEdges,
    truncated: shownNodes < nodeRecords.length || shownEdges < edgeRecords.length,
    selectedIdSet: selectedIds,
    arrayBytes: used,
  };
}

/** Per-node note counts from the ledger's latest records (bound ids only). */
async function collectNoteCounts(rootAbs) {
  try {
    const counts = {};
    for (const rec of latestByKey(await readNotes(rootAbs)).values()) {
      const ids = rec.kind === 'edge' ? [rec.fromNodeId, rec.toNodeId] : [rec.nodeId];
      for (const id of ids) {
        if (typeof id === 'string' && id) counts[id] = (counts[id] ?? 0) + 1;
      }
    }
    return counts;
  } catch {
    return {}; // advisory only — absence of note counts renders as 0 in-UI
  }
}

async function readSegmentForView(absPath, label) {
  try {
    return await readSegment(absPath);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new StoreCorruptError(`${label} segment is corrupt (${err.message}); run \`scope scan --full\` to rebuild`);
    }
    throw err;
  }
}

/** Per-list caps so an oversized check summary cannot blow the data budget. */
const LENS_LIST_LIMITS = Object.freeze({ drift: 250, dangling: 250, orphans: 150, ambiguous: 100, tests: 120 });
/** Byte cap for the per-node note-count map (advisory data, honestly flagged). */
export const NOTES_BYTE_CAP = 65_536;

function clipList(list, limitKey, project) {
  const src = Array.isArray(list) ? list : [];
  const limit = LENS_LIST_LIMITS[limitKey];
  return {
    items: src.slice(0, limit).map(project),
    more: Math.max(0, src.length - limit),
  };
}

function lensProjection(lens) {
  if (!lens || lens.v !== CHECK_LATEST_V) return null;
  const drift = clipList(lens.drift, 'drift', (d) => ({
    i: d.node?.id ?? null,
    n: d.name,
    p: d.path,
    sl: d.node?.sl ?? null,
    el: d.node?.el ?? null,
    c: d.node?.confidence ?? null,
    deps: (d.dependents ?? [])
      .slice(0, 12)
      .map((dep) => ({ i: dep.id, n: dep.name, p: dep.path, sl: dep.sl, el: dep.el, c: dep.confidence })),
    moreDeps: Math.max(0, (d.dependents?.length ?? 0) - 12),
  }));
  const dangling = clipList(lens.dangling, 'dangling', (g) => ({
    si: g.source?.id ?? null,
    sn: g.source?.name ?? null,
    sp: g.source?.path ?? null,
    ssl: g.source?.sl ?? null,
    sel: g.source?.el ?? null,
    ti: g.target?.id ?? null,
    tn: g.target?.name ?? null,
    type: g.type,
    c: g.confidence,
  }));
  const orphans = clipList(lens.orphans, 'orphans', (o) => ({ key: o.key, text: o.text, ref: o.ref }));
  const ambiguous = clipList(lens.ambiguous, 'ambiguous', (a) => ({ key: a.key, n: a.candidates?.length ?? 0 }));
  const tests = clipList(lens.tests, 'tests', (t) => ({ path: t.path, confidence: t.confidence }));
  const rebindings = Array.isArray(lens.rebindings) ? lens.rebindings : [];
  return {
    issues: lens.issues,
    counts: lens.counts,
    dirty: lens.dirty,
    drift: drift.items,
    moreDrift: drift.more,
    dangling: dangling.items,
    moreDangling: dangling.more,
    orphans: orphans.items,
    moreOrphans: orphans.more,
    ambiguous: ambiguous.items,
    moreAmbiguous: ambiguous.more,
    rebindings: rebindings.slice(0, 50),
    moreRebindings: Math.max(0, rebindings.length - 50),
    runners: lens.runners ?? [],
    tests: tests.items,
    moreTests: tests.more,
  };
}

/**
 * Cap the advisory note-count map to selected ids and a byte budget.
 * Overflow drops whole keys (never partial JSON) and sets `partial`.
 */
function boundedNoteCounts(rawNotes, selectedIds) {
  let pairs = Object.entries(rawNotes ?? {})
    .filter(([id]) => selectedIds.has(id))
    .sort((a, b) => cmpStr(a[0], b[0]));
  const notes = {};
  let used = 0;
  let partial = false;
  for (const [id, n] of pairs) {
    const cost = id.length + String(n).length + 4;
    if (used + cost > NOTES_BYTE_CAP) {
      partial = true;
      break;
    }
    used += cost;
    notes[id] = n;
  }
  return { notes, notesPartial: partial };
}

function assemblePayload({ meta, root, lens, notes, selection }) {
  const { notes: cappedNotes, notesPartial } = boundedNoteCounts(notes, selection.selectedIdSet);
  return {
    v: VIEW_PAYLOAD_V,
    tool: typeof meta.tool === 'string' ? meta.tool : TOOL_ID,
    schemaVersion: meta.schemaVersion,
    root,
    maxTotalBytes: VIEWER_MAX_TOTAL_BYTES,
    totals: { n: selection.totalNodes, e: selection.totalEdges },
    shown: { n: selection.shownNodes, e: selection.shownEdges },
    truncated: selection.truncated,
    notesPartial,
    entrypoints: selection.entrypoints,
    nodes: selection.nodesCompact,
    edges: selection.edgesCompact,
    notes: cappedNotes,
    lens: lensProjection(lens),
  };
}

/**
 * Build the full embedded payload (pure data, no HTML). Reads the index and
 * the optional check summary; NEVER rescans or writes to the index — the
 * viewer is a passive read model (`scope scan` / `scope check` own mutations).
 *
 * The greedy cut bounds node+edge arrays; header/lens/notes overhead around
 * them is mopped up by an iterate-and-shrink loop so the hard total-file cap
 * always holds (asserted again after template injection).
 */
export async function buildViewPayload(rootAbs, deps = {}) {
  const root = path.resolve(rootAbs);
  const dir = storeDirFor(root);

  const metaState = deps.readMetaImpl ? await deps.readMetaImpl(dir) : await readMeta(dir);
  if (metaState.status === 'older') {
    throw new IncompleteIndexError(
      `index schemaVersion is older than supported ${SCHEMA_VERSION}; run \`scope scan\` to rebuild`,
    );
  }
  if (metaState.status !== 'ok' || !metaState.meta?.complete) {
    throw new IncompleteIndexError(`no complete symbol index at ${toPosix(dir)}; run \`scope scan\` first`);
  }
  const meta = metaState.meta;

  const [nodeRecords, edgeRecords] = await Promise.all([
    readSegmentForView(path.join(dir, NODES_SEGMENT), 'nodes'),
    readSegmentForView(path.join(dir, EDGES_SEGMENT), 'edges'),
  ]);

  const lens = deps.readCheckLatestImpl ? await deps.readCheckLatestImpl(root) : await readCheckLatest(root);
  const notes = deps.noteCountsImpl ? await deps.noteCountsImpl(root) : await collectNoteCounts(root);

  const templateBytes = Buffer.byteLength(await loadTemplate(), 'utf8');
  let dataBudgetBytes = VIEWER_MAX_TOTAL_BYTES - templateBytes - VIEW_DATA_SAFETY_MARGIN;

  // Iterate: select -> assemble -> measure. Overshoot shrinks the budget for
  // the next pass; monotone in budget, deterministic, converges in 1-2 passes.
  let selection = null;
  let payload = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    selection = selectBoundedView(nodeRecords, edgeRecords, dataBudgetBytes);
    payload = assemblePayload({ meta, root: toPosix(root), lens, notes, selection });
    const islandBytes = Buffer.byteLength(escapeJsonIsland(JSON.stringify(payload)), 'utf8');
    const projectedTotal = templateBytes - DATA_TOKEN.length + islandBytes;
    const target = VIEWER_MAX_TOTAL_BYTES - VIEW_DATA_SAFETY_MARGIN;
    if (projectedTotal <= target) {
      return { payload, selection, templateBytes, dataBudgetBytes };
    }
    dataBudgetBytes -= projectedTotal - target;
  }
  // Unreachable in practice; kept as a fail-loud backstop.
  throw new Error('internal error: viewer payload failed to converge under the size bound');
}

/** Escape JSON for safe embedding inside a <script type="application/json"> island. */
export function escapeJsonIsland(jsonText) {
  return jsonText.replace(/</g, '\\u003C').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export async function buildViewHtml(rootAbs, deps = {}) {
  const { payload, selection, templateBytes, dataBudgetBytes } = await buildViewPayload(rootAbs, deps);
  const html = (await loadTemplate()).replace(DATA_TOKEN, () => escapeJsonIsland(JSON.stringify(payload)));
  const totalBytes = Buffer.byteLength(html, 'utf8');
  if (totalBytes > VIEWER_MAX_TOTAL_BYTES) {
    // Internal invariant: the greedy cut must guarantee the hard cap.
    throw new Error(
      `internal error: viewer output ${totalBytes}B exceeds the ${VIEWER_MAX_TOTAL_BYTES}B bound ` +
        `(budget was ${dataBudgetBytes}B for ${templateBytes}B template)`,
    );
  }
  return {
    html,
    totalBytes,
    stats: {
      totalNodes: selection.totalNodes,
      totalEdges: selection.totalEdges,
      shownNodes: selection.shownNodes,
      shownEdges: selection.shownEdges,
      truncated: selection.truncated,
    },
  };
}

/** Thrown when the requested output location cannot be written (exit 2 class). */
export class ViewOutputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ViewOutputError';
  }
}

/**
 * Generate the viewer file. Default destination: `<root>/.scope/symbols/view-data.html`.
 * Never touches the index; returns the absolute output path + honest counts.
 */
export async function generateViewFile({ root, out } = {}) {
  const rootAbs = path.resolve(root ?? process.cwd());
  let outAbs;
  if (out) {
    outAbs = path.resolve(out);
    try {
      if ((await stat(outAbs)).isDirectory()) throw new ViewOutputError(`--out "${out}" is a directory`);
    } catch (err) {
      if (err instanceof ViewOutputError) throw err;
      if (err?.code !== 'ENOENT') throw err;
    }
  } else {
    outAbs = path.join(rootAbs, SYMBOLS_DIRNAME, VIEW_OUTPUT_FILE);
  }
  const { html, totalBytes, stats } = await buildViewHtml(rootAbs);
  await atomicWriteFile(outAbs, html);
  return { outAbs, outPosix: toPosix(outAbs), totalBytes, ...stats };
}
