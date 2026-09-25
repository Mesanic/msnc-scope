import {
  LOCATE_DEFAULT_LIMIT,
  LOCATE_HIT_TOKENS,
  LOCATE_MAX_LIMIT,
  estimateTokens,
} from './tokens.mjs';
import { UsageError } from './usage-error.mjs';

/**
 * BM25-style ranked search over node names, signatures, and summaries.
 *
 * Constants (documented per design doc §7):
 *   k1 = 1.5, b = 0.75 — standard BM25 parameters.
 *   Field weights: name 3.0, sig 1.0, summary 0.6 — a name hit outweighs a
 *   passing mention. Per-field BM25 scores are combined as a weighted sum.
 */
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;
export const FIELD_WEIGHTS = Object.freeze({ name: 3, sig: 1, summary: 0.6 });
const FIELDS = Object.freeze(['name', 'sig', 'summary']);

/**
 * Split identifiers/text into search tokens.
 *
 * Semantics (canonical):
 *   - Input splits on non-alphanumeric runs (`_`, `$`, spaces, punctuation).
 *   - Each alphanumeric chunk splits further at camelCase/PascalCase/digit
 *     boundaries; parts are lowercased ("getUserById" -> get user by id).
 *     Parts are what matching happens on, in both query and document fields.
 *   - When the whole input is a single whitespace-free token, its lowercased
 *     original form (separators preserved: "parse_json_blob") is appended
 *     LAST as a boost term, so an identifier query/doc also matches itself
 *     exactly. Multi-word inputs emit no boost.
 *   - Output is deduped, preserving first-occurrence order (parts before
 *     boost).
 */
export function tokenize(text) {
  const raw = String(text ?? '');
  const chunks = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const chunk of chunks) {
    const split = chunk
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-zA-Z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-zA-Z])/g, '$1 $2');
    for (const part of split.split(/\s+/)) {
      push(part.toLowerCase());
    }
  }
  const trimmed = raw.trim();
  if (trimmed.length > 0 && !/\s/.test(trimmed) && /[A-Za-z0-9]/.test(trimmed)) {
    push(trimmed.toLowerCase());
  }
  return out;
}

function fieldTextOf(node, field) {
  if (field === 'name') return node.name ?? '';
  if (field === 'sig') return node.sig ?? '';
  return node.summary ?? '';
}

/** Inverted index per field: term -> [{ doc, tf }], plus per-doc lengths. */
function buildFieldIndex(docs, field) {
  const postings = new Map();
  const docLen = new Array(docs.length).fill(0);
  for (let i = 0; i < docs.length; i++) {
    const terms = tokenize(fieldTextOf(docs[i], field));
    docLen[i] = terms.length;
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, count] of tf) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push({ doc: i, tf: count });
    }
  }
  let total = 0;
  for (const len of docLen) total += len;
  return { postings, docLen, avgdl: docs.length > 0 ? total / docs.length : 0 };
}

export function buildSearchIndex(nodes) {
  const docs = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fields = {};
  for (const f of FIELDS) fields[f] = buildFieldIndex(docs, f);
  return { docs, fields };
}

function bm25Idf(df, n) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

/** Score every document for the query terms; returns Map(docIdx -> score). */
function scoreQuery(index, queryTerms) {
  const n = index.docs.length;
  const scores = new Map();
  const seen = new Set();
  for (const term of queryTerms) {
    if (seen.has(term)) continue;
    seen.add(term);
    for (const fieldName of FIELDS) {
      const field = index.fields[fieldName];
      const list = field.postings.get(term);
      if (!list || list.length === 0) continue;
      const idf = bm25Idf(list.length, n);
      const weight = FIELD_WEIGHTS[fieldName];
      for (const { doc, tf } of list) {
        const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * field.docLen[doc]) / (field.avgdl || 1));
        const s = (weight * idf * tf * (BM25_K1 + 1)) / denom;
        scores.set(doc, (scores.get(doc) ?? 0) + s);
      }
    }
  }
  return scores;
}

export function searchNodes(index, query, limit = LOCATE_DEFAULT_LIMIT) {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const scores = scoreQuery(index, terms);
  const hits = [];
  for (const [doc, score] of scores) {
    hits.push({ node: index.docs[doc], score });
  }
  hits.sort((a, b) => b.score - a.score || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0));
  const capped = Math.max(0, Math.min(Math.floor(limit), LOCATE_MAX_LIMIT));
  return capped < hits.length ? hits.slice(0, capped) : hits;
}

const ELLIPSIS = '…';

/**
 * Format one locate hit line targeting ~40 tokens:
 *   `<id> <kind> <name> <path>:<sl>-<el> <conf> <sig>`
 * The signature is truncated so the whole line fits the LOCATE_HIT_TOKENS
 * budget (enforced with the shared estimator).
 */
export function formatHit(node) {
  const span = `${node.path}:${node.span.sl}-${node.span.el}`;
  let base = `${node.id} ${node.kind} ${node.name} ${span} ${node.confidence}`;
  const sig = typeof node.sig === 'string' ? node.sig : '';
  if (sig) base += ` ${sig}`;
  let line = base.replace(/\s+/g, ' ').trim();
  if (estimateTokens(line) > LOCATE_HIT_TOKENS) {
    const keep = LOCATE_HIT_TOKENS * 4 - ELLIPSIS.length;
    line = line.slice(0, keep).trimEnd() + ELLIPSIS;
  }
  return line;
}

export function formatHitsJson(query, hits) {
  const round4 = (x) => Math.round(x * 10000) / 10000;
  return JSON.stringify({
    query,
    hits: hits.map((h) => ({
      id: h.node.id,
      kind: h.node.kind,
      name: h.node.name,
      path: h.node.path,
      span: { sl: h.node.span.sl, el: h.node.span.el },
      confidence: h.node.confidence,
      sig: h.node.sig ?? '',
      score: round4(h.score),
    })),
  });
}

export function parseLimit(raw) {
  if (raw === undefined) return LOCATE_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new UsageError(`--limit must be a positive integer, got "${raw}"`);
  }
  return Math.min(n, LOCATE_MAX_LIMIT);
}
