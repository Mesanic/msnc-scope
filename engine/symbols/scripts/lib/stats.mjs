import path from 'node:path';
import {
  EDGES_SEGMENT,
  NODES_SEGMENT,
  SCHEMA_VERSION,
  readMeta,
  readSegment,
  storeDirFor,
} from './store.mjs';
import { StoreCorruptError } from './query-store.mjs';
import { UsageError } from './usage-error.mjs';
import { cmpStr, toPosix } from './util.mjs';

/**
 * `scope stats` — read-only index statistics from meta.json + segments.
 * Deliberately does NOT resync: stats describe the store as it sits on disk.
 * Volatile fields (timestamps, durations, last-scan counters) are confined to
 * the clearly-flagged `lastScan` block; everything else is deterministic for
 * a given store state and sorted lexicographically.
 */
export async function collectStats(rootAbs) {
  const dir = storeDirFor(path.resolve(rootAbs));
  const metaState = await readMeta(dir);
  if (metaState.status === 'missing') {
    throw new UsageError('this repo is not indexed yet; run `scope scan` first');
  }
  if (metaState.status === 'corrupt') {
    throw new StoreCorruptError('meta.json is corrupt; run `scope scan --full` to rebuild');
  }
  if (metaState.status === 'older') {
    throw new UsageError(
      `index schemaVersion ${metaState.meta.schemaVersion} is older than supported ${SCHEMA_VERSION}; run \`scope scan\` to rebuild`,
    );
  }
  const meta = metaState.meta;

  let nodeRecords;
  let edgeRecords;
  try {
    nodeRecords = await readSegment(path.join(dir, NODES_SEGMENT));
    edgeRecords = await readSegment(path.join(dir, EDGES_SEGMENT));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new StoreCorruptError(`index segment is corrupt (${err.message}); run \`scope scan --full\` to rebuild`);
    }
    throw err;
  }

  const nodesByKind = countBy(nodeRecords, (n) => n.kind);
  const edgesByType = countBy(edgeRecords, (e) => e.type);
  const edgesByConfidence = countBy(edgeRecords, (e) => e.confidence);
  const stats = meta.stats ?? {};
  const languages = {};
  for (const [lang, count] of Object.entries(stats.languages ?? {})) languages[lang] = count;

  const fileLangByPath = new Map();
  for (const [p, rec] of Object.entries(meta.files ?? {})) {
    if (rec && typeof rec.lang === 'string') fileLangByPath.set(p, rec.lang);
  }
  const languageDetails = buildLanguageDetails(nodeRecords, edgeRecords, fileLangByPath);

  return {
    storePosixDir: toPosix(dir),
    schemaVersion: meta.schemaVersion,
    tool: meta.tool ?? 'unknown',
    complete: Boolean(meta.complete),
    placeholder: Boolean(meta.placeholder),
    files: stats.files ?? Object.keys(meta.files ?? {}).length,
    bytes: stats.bytes ?? 0,
    skipped: {
      binary: stats.skippedBinary ?? 0,
      oversize: stats.skippedOversize ?? 0,
    },
    unresolved: {
      imports: stats.unresolvedImports ?? 0,
      droppedCalls: stats.droppedCalls ?? 0,
      barrelOverflows: stats.barrelOverflows ?? 0,
    },
    nodes: { total: nodeRecords.length, byKind: sortCounts(nodesByKind) },
    edges: {
      total: edgeRecords.length,
      byType: sortCounts(edgesByType),
      byConfidence: sortCounts(edgesByConfidence),
    },
    languages: sortCounts(languages),
    languageDetails,
    lastScan: {
      updatedAt: meta.updatedAt ?? null,
      durationMs: meta.durationMs ?? null,
      scanned: stats.scanned ?? null,
      reused: stats.reused ?? null,
    },
  };
}

/**
 * Per-language breakdown over the store segments. Files come from meta.files
 * (lang recorded per path at scan time); nodes/edges are attributed through
 * their own lang / origin-file (f) fields. Rough records (structural fallback)
 * are counted per language via node confidence 'rough'. All maps are emitted
 * sorted for determinism.
 */
function buildLanguageDetails(nodeRecords, edgeRecords, fileLangByPath) {
  const details = new Map();
  const ensure = (lang, filePath) => {
    if (!details.has(lang)) {
      details.set(lang, { files: new Set(), nodes: 0, edges: 0, byConfidence: {}, roughNodes: 0 });
    }
    const d = details.get(lang);
    if (filePath) d.files.add(filePath);
    return d;
  };
  for (const [p, lang] of fileLangByPath) ensure(lang, p);
  for (const n of nodeRecords) {
    const lang = typeof n.lang === 'string' ? n.lang : 'unknown';
    const d = ensure(lang, typeof n.path === 'string' ? n.path : undefined);
    d.nodes += 1;
    if (n.confidence === 'rough') d.roughNodes += 1;
  }
  for (const e of edgeRecords) {
    const originLang = fileLangByPath.get(e.f ?? '');
    if (!originLang && e.f) continue;
    const lang = originLang ?? 'unknown';
    const d = ensure(lang, undefined);
    d.edges += 1;
    const c = String(e.confidence ?? '?');
    d.byConfidence[c] = (d.byConfidence[c] ?? 0) + 1;
  }
  const out = {};
  for (const lang of [...details.keys()].sort(cmpStr)) {
    const d = details.get(lang);
    out[lang] = {
      files: d.files.size,
      nodes: d.nodes,
      edges: d.edges,
      edgesByConfidence: sortCounts(d.byConfidence),
      rough: d.roughNodes,
    };
  }
  return out;
}

function countBy(records, pick) {
  const counts = {};
  for (const rec of records) {
    const key = String(pick(rec) ?? '?');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function sortCounts(counts) {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => cmpStr(a[0], b[0])));
}

function kvLine(label, counts) {
  const body = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ');
  return `${label}: ${body || '-'}`;
}

/** Fixed small format; every multi-value line is sorted; volatile block flagged. */
export function formatStats(s) {
  const lines = [
    `stats ${s.storePosixDir}`,
    `schema: v${s.schemaVersion} (${s.tool})${s.complete ? '' : ' [incomplete]'}`,
    `files: ${s.files} (bytes ${s.bytes})`,
    `skipped: binary=${s.skipped.binary}, oversize=${s.skipped.oversize}`,
    kvLine('languages', s.languages),
    ...languageDetailLines(s.languageDetails ?? {}),
    `nodes: ${s.nodes.total}`,
    kvLine('kinds', s.nodes.byKind),
    `edges: ${s.edges.total}`,
    kvLine('types', s.edges.byType),
    kvLine('confidence', s.edges.byConfidence),
    `unresolved: imports=${s.unresolved.imports}, droppedCalls=${s.unresolved.droppedCalls}, barrelOverflows=${s.unresolved.barrelOverflows}`,
    `lastScan (volatile): updatedAt=${s.lastScan.updatedAt ?? '-'} durationMs=${s.lastScan.durationMs ?? '-'} scanned=${s.lastScan.scanned ?? '-'} reused=${s.lastScan.reused ?? '-'}`,
  ];
  if (s.placeholder) lines.push('note: placeholder meta from `symbols.mjs init`; first `scope scan` will replace it');
  return lines.join('\n');
}

function languageDetailLines(details) {
  const out = [];
  for (const lang of Object.keys(details).sort(cmpStr)) {
    const d = details[lang];
    const conf = Object.entries(d.edgesByConfidence ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    out.push(`lang ${lang}: files=${d.files} nodes=${d.nodes} edges=${d.edges}${conf ? ` (${conf})` : ''} rough=${d.rough}`);
  }
  return out;
}
