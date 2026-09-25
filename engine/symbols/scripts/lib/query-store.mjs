import path from 'node:path';
import {
  EDGES_SEGMENT,
  NODES_SEGMENT,
  readMeta,
  readSegment,
  storeDirFor,
} from './store.mjs';
import { scan } from './scan.mjs';
import { cmpStr } from './util.mjs';
import { moduleIdForFile, TEST_FILE_PATTERNS } from './resolve.mjs';

/** Thrown when the index cannot be brought to a complete state before answering. */
export class IncompleteIndexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IncompleteIndexError';
  }
}

/** Thrown when segment files exist but cannot be parsed. */
export class StoreCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreCorruptError';
  }
}

export function isTestFilePath(posixPath) {
  return TEST_FILE_PATTERNS.some((re) => re.test(posixPath));
}

/**
 * Auto-incremental resync: runs the M1 scan fast path (cheap when nothing
 * changed). Failure to resync propagates (IndexVersionError or I/O error) —
 * callers must never answer from a stale or broken index.
 */
export async function resyncIndex(root, deps = {}) {
  const scanImpl = deps.scanImpl ?? scan;
  return scanImpl({ root });
}

async function readSegmentGuarded(absPath, label) {
  try {
    return await readSegment(absPath);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new StoreCorruptError(
        `${label} segment is corrupt (${err.message}); run \`scope scan --full\` to rebuild`,
      );
    }
    throw err;
  }
}

/**
 * Build in-memory query structures from raw node/edge records.
 * Deterministic: all adjacency lists are sorted at build time.
 */
export function buildStore(nodes, edges) {
  const sortedNodes = [...nodes].sort((a, b) => cmpStr(a.id, b.id));
  const nodesById = new Map();
  const byName = new Map();
  const moduleByPath = new Map();
  const trackedPaths = new Set();

  for (const n of sortedNodes) {
    nodesById.set(n.id, n);
    if (!byName.has(n.name)) byName.set(n.name, []);
    byName.get(n.name).push(n);
    trackedPaths.add(n.path);
    if (n.kind === 'module') moduleByPath.set(n.path, n);
  }

  const adjOut = new Map();
  const adjIn = new Map();
  const parents = new Map();
  for (const e of edges) {
    if (!adjOut.has(e.src)) adjOut.set(e.src, []);
    if (!adjIn.has(e.dst)) adjIn.set(e.dst, []);
    adjOut.get(e.src).push(e);
    adjIn.get(e.dst).push(e);
    if (e.type === 'contains' && !parents.has(e.dst)) parents.set(e.dst, e.src);
  }
  const byEdge = (a, b) =>
    cmpStr(`${a.confidence}|${a.type}|${a.src}|${a.dst}`, `${b.confidence}|${b.type}|${b.src}|${b.dst}`);
  for (const list of adjOut.values()) list.sort(byEdge);
  for (const list of adjIn.values()) list.sort(byEdge);

  return { nodes: sortedNodes, edges, nodesById, byName, moduleByPath, trackedPaths, adjOut, adjIn, parents };
}

export function moduleIdOfNode(node) {
  return moduleIdForFile(node.path, node.lang);
}

/**
 * Resync, refuse incomplete indexes, then load segments into a query store.
 * `deps.scanImpl` is injectable so tests can simulate unrepairable
 * incompleteness deterministically.
 */
export async function loadQueryStore(root, deps = {}) {
  const result = await resyncIndex(root, deps);
  if (!result.complete) {
    const n = result.warnings?.length ?? 0;
    throw new IncompleteIndexError(
      `index is incomplete (${n} file${n === 1 ? '' : 's'} failed extraction); ` +
        'run `scope scan` to inspect warnings — refusing to answer from an incomplete index',
    );
  }
  const dir = storeDirFor(path.resolve(root));
  const metaState = await readMeta(dir);
  if (metaState.status !== 'ok' || !metaState.meta?.complete) {
    throw new IncompleteIndexError(
      'index is missing or not marked complete; run `scope scan` to rebuild',
    );
  }
  const nodes = await readSegmentGuarded(path.join(dir, NODES_SEGMENT), 'nodes');
  const edges = await readSegmentGuarded(path.join(dir, EDGES_SEGMENT), 'edges');
  return { root: path.resolve(root), meta: metaState.meta, ...buildStore(nodes, edges) };
}
