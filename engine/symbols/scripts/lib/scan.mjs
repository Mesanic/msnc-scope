import { mkdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  EDGES_SEGMENT,
  FACTS_SEGMENT,
  NODES_SEGMENT,
  SCHEMA_VERSION,
  TOOL_ID,
  IndexVersionError,
  readMeta,
  readSegment,
  storeDirFor,
  storePosixDirFor,
  writeMeta,
  writeSegment,
} from './store.mjs';
import { buildGraph } from './resolve.mjs';
import { MAX_SOURCE_FILE_BYTES, walkSourceFiles } from './walk.mjs';
import { cmpStr } from './util.mjs';

export { IndexVersionError };

const WORKER_URL = new URL('./scan-worker.mjs', import.meta.url);

function defaultJobs() {
  const cpus = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(8, cpus));
}

function runWorkerPool(jobs, concurrency) {
  return new Promise((resolvePool) => {
    if (jobs.length === 0) {
      resolvePool({ results: new Map(), failures: [] });
      return;
    }
    const queue = [...jobs];
    let next = 0;
    const results = new Map();
    const failures = [];
    const live = new Set();

    const spawnCount = Math.max(1, Math.min(concurrency, jobs.length));

    function maybeFinish() {
      if (live.size > 0) return;
      resolvePool({ results, failures });
    }

    function pump(worker, state) {
      if (state.busy || state.closed) return;
      if (next >= queue.length) {
        state.closed = true;
        worker.terminate().then(() => {
          live.delete(worker);
          maybeFinish();
        });
        return;
      }
      state.busy = true;
      const job = queue[next++];
      state.currentJob = job;
      worker.postMessage(job);
    }

    for (let i = 0; i < spawnCount; i++) {
      const worker = new Worker(WORKER_URL, { workerData: { workerId: i } });
      live.add(worker);
      const state = { busy: false, closed: false, currentJob: null };

      worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          pump(worker, state);
          return;
        }
        if (msg.type !== 'done') return;
        const result = msg.result ?? {};
        if (result.error) failures.push({ path: String(result.path ?? state.currentJob?.posixPath ?? '?'), error: result.error });
        else results.set(result.path, result);
        state.busy = false;
        state.currentJob = null;
        pump(worker, state);
      });

      worker.on('error', (err) => {
        if (state.currentJob) {
          failures.push({
            path: state.currentJob.posixPath,
            error: `worker error: ${String(err?.message ?? err)}`,
          });
          state.currentJob = null;
        }
        state.closed = true;
        worker.terminate().then(() => {
          live.delete(worker);
          maybeFinish();
        });
      });

      worker.on('exit', (code) => {
        if (!state.closed) {
          state.closed = true;
          if (state.currentJob) {
            failures.push({ path: state.currentJob.posixPath, error: `worker exited with code ${code}` });
            state.currentJob = null;
          }
          live.delete(worker);
          maybeFinish();
        }
      });
    }
  });
}

/**
 * Scheduling pass shared by `scan`: classify each walked entry as reused,
 * to-scan, oversize-skipped or vanished. Exported pure so the ENOENT guard
 * (files deleted between readdir and stat — routine on Windows with editors,
 * AV and indexers) stays unit-testable without racing a real scan. A vanished
 * path is treated as deleted: it is never scheduled, never resurrected from
 * prior facts, and simply absent from the new store (deletion semantics).
 */
export async function collectScanJobs(rootAbs, walked, opts = {}) {
  const forceFull = Boolean(opts.forceFull);
  const priorMeta = opts.priorMeta ?? null;
  const priorFactsByPath = opts.priorFactsByPath ?? null;

  const scanJobs = [];
  const statByPosix = new Map();
  const oversizePaths = [];
  const vanishedPaths = new Set();
  let reusedCount = 0;

  for (const entry of walked) {
    const absPath = path.join(rootAbs, entry.posixPath);
    let st;
    try {
      st = await stat(absPath);
    } catch {
      vanishedPaths.add(entry.posixPath);
      continue;
    }
    statByPosix.set(entry.posixPath, { mtimeMs: st.mtimeMs, size: st.size });
    // Oversize gate runs BEFORE the reuse fast path: an oversized file must
    // never be scheduled for parsing NOR silently reused from a prior store
    // (e.g. one written by a pre-cap version) — including its own stale
    // facts when it was indexed back when it was still small.
    if (st.size > MAX_SOURCE_FILE_BYTES) {
      oversizePaths.push(entry.posixPath);
      continue;
    }
    const priorFile = forceFull ? null : priorMeta?.files?.[entry.posixPath];
    const priorFacts =
      priorFile &&
      priorFile.size === st.size &&
      priorFile.mtimeMs === st.mtimeMs &&
      priorFile.lang === entry.lang
        ? priorFactsByPath?.get(entry.posixPath)
        : null;
    if (priorFacts && priorFacts.hash === priorFile.hash && priorFacts.facts) {
      reusedCount += 1;
      continue;
    }
    scanJobs.push({ absPath, posixPath: entry.posixPath, lang: entry.lang });
  }

  return { scanJobs, statByPosix, oversizePaths, vanishedPaths, reusedCount };
}

export async function scan(options = {}) {
  const startedAt = Date.now();
  const rootAbs = path.resolve(options.root ?? process.cwd());
  const full = Boolean(options.full);
  const jobsOpt = options.jobs;

  const dir = storeDirFor(rootAbs);
  const metaState = await readMeta(dir);
  if (metaState.status === 'future') {
    throw new IndexVersionError(
      metaState.error?.message ??
        'index schemaVersion is newer than supported; run `scope scan` with an up-to-date Scope to rebuild',
    );
  }

  const priorMeta = metaState.status === 'ok' ? metaState.meta : null;
  let forceFull = full || !priorMeta;

  let priorFactsByPath = null;
  if (!forceFull) {
    try {
      const factRecords = await readSegment(path.join(dir, FACTS_SEGMENT));
      priorFactsByPath = new Map(factRecords.filter((r) => r._ === 'facts').map((r) => [r.path, r]));
    } catch {
      priorFactsByPath = null;
      forceFull = true;
    }
  }

  const walked = await walkSourceFiles(rootAbs);

  const { scanJobs, statByPosix, oversizePaths, vanishedPaths, reusedCount } = await collectScanJobs(rootAbs, walked, {
    forceFull,
    priorMeta,
    priorFactsByPath,
  });
  const oversizeSet = new Set(oversizePaths);

  const { results, failures } = await runWorkerPool(scanJobs, Number.isFinite(jobsOpt) ? Math.max(1, Math.floor(jobsOpt)) : defaultJobs());

  const filesForGraph = [];
  let skippedBinary = 0;
  const failedPaths = new Set(failures.map((f) => f.path));
  const factsSegmentRecords = [];

  for (const entry of walked) {
    const p = entry.posixPath;
    // Oversized and vanished paths are excluded from the assembled graph AND
    // from meta.files: re-pushing their stale prior facts would resurrect a
    // file the cap (or the filesystem) says is gone.
    if (oversizeSet.has(p) || vanishedPaths.has(p)) continue;
    if (failedPaths.has(p)) continue;
    const fresh = results.get(p);
    if (fresh && fresh.skipped === 'binary') {
      skippedBinary += 1;
      continue;
    }
    const stInfo = statByPosix.get(p);
    if (fresh) {
      filesForGraph.push({
        path: p,
        lang: fresh.lang,
        hash: fresh.hash,
        bytes: fresh.size,
        mtimeMs: stInfo.mtimeMs,
        facts: fresh.facts,
      });
    } else {
      const priorFile = priorMeta?.files?.[p];
      const priorFacts = priorFactsByPath?.get(p);
      if (!priorFile || !priorFacts || !priorFacts.facts) continue;
      filesForGraph.push({
        path: p,
        lang: priorFacts.lang ?? entry.lang,
        hash: priorFacts.hash,
        bytes: priorFacts.size,
        mtimeMs: stInfo.mtimeMs,
        facts: priorFacts.facts,
      });
    }
  }

  filesForGraph.sort((a, b) => cmpStr(a.path, b.path));

  let goModulePath = null;
  if (walked.some((e) => e.lang === 'go')) {
    try {
      const raw = await readFile(path.join(rootAbs, 'go.mod'), 'utf8');
      const m = /^\s*module\s+(\S+)\s*$/m.exec(raw);
      if (m) goModulePath = m[1];
    } catch {
      goModulePath = null;
    }
  }

  const graph = buildGraph(filesForGraph, { goModulePath });

  const filesRecord = {};
  let totalBytes = 0;
  const languages = {};
  for (const f of filesForGraph) {
    factsSegmentRecords.push({ _: 'facts', path: f.path, lang: f.lang, hash: f.hash, size: f.bytes, facts: f.facts });
    filesRecord[f.path] = { hash: f.hash, size: f.bytes, mtimeMs: f.mtimeMs, lang: f.lang };
    totalBytes += f.bytes;
    languages[f.lang] = (languages[f.lang] ?? 0) + 1;
  }

  const nodesByKind = {};
  for (const n of graph.nodes) nodesByKind[n.kind] = (nodesByKind[n.kind] ?? 0) + 1;
  const edgesByType = {};
  for (const e of graph.edges) edgesByType[e.type] = (edgesByType[e.type] ?? 0) + 1;

  const nowIso = new Date().toISOString();
  const meta = {
    _: 'meta',
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL_ID,
    createdAt: priorMeta?.createdAt ?? nowIso,
    updatedAt: nowIso,
    complete: failures.length === 0,
    durationMs: Date.now() - startedAt,
    stats: {
      files: filesForGraph.length,
      scanned: filesForGraph.length - reusedCount,
      reused: reusedCount,
      skippedBinary,
      skippedOversize: oversizePaths.length,
      failed: failures.length,
      unresolvedImports: graph.stats.unresolvedImports,
      droppedCalls: graph.stats.droppedCalls,
      barrelOverflows: graph.stats.barrelOverflows,
      languages,
      bytes: totalBytes,
      nodes: { total: graph.nodes.length, byKind: nodesByKind },
      edges: { total: graph.edges.length, byType: edgesByType },
    },
    files: filesRecord,
  };

  await mkdir(dir, { recursive: true });
  await writeSegment(path.join(dir, NODES_SEGMENT), graph.nodes);
  await writeSegment(path.join(dir, EDGES_SEGMENT), graph.edges);
  await writeSegment(path.join(dir, FACTS_SEGMENT), factsSegmentRecords);
  await writeMeta(dir, meta);

  return {
    root: rootAbs,
    storeDir: dir,
    storePosixDir: storePosixDirFor(rootAbs),
    complete: meta.complete,
    forcedFull: full || forceFull,
    warnings: failures,
    oversizeSkipped: oversizePaths,
    meta,
    counts: {
      tracked: filesForGraph.length,
      scanned: meta.stats.scanned,
      reused: reusedCount,
      skippedBinary,
      skippedOversize: oversizePaths.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
    },
  };
}
