// Inverted index + ranked retrieval. Tokenization must be identical at index and query time.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './store.mjs';

const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were', 'has', 'have',
  'but', 'not', 'you', 'all', 'can', 'its', 'his', 'her', 'they', 'them', 'when', 'what',
  'which', 'who', 'how', 'why', 'into', 'out', 'via', 'per', 'use', 'used', 'uses', 'one',
  'two', 'new', 'get', 'set', 'add', 'run', 'see', 'also', 'each', 'any', 'may', 'lines',
  'loc', 'file', 'files', 'code',
]);

const POSTING_CAP = 64;

export function tokenizeKey(key) {
  const out = new Set();
  const base = key.slice(key.lastIndexOf('/') + 1);
  if (base && base !== key) out.add(base.toLowerCase());
  for (const raw of key.split(/[/.\-_#\s:]+/)) {
    if (!raw) continue;
    const low = raw.toLowerCase();
    if (low.length >= 2) out.add(low);
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    if (parts.length > 1) for (const p of parts) if (p.length >= 2) out.add(p.toLowerCase());
  }
  return out;
}

export function tokenizeText(text) {
  const out = new Set();
  for (const raw of String(text).split(/[^A-Za-z0-9_$]+/)) {
    if (!raw) continue;
    const low = raw.toLowerCase();
    if (low.length >= 3 && !STOP.has(low)) out.add(low);
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    if (parts.length > 1) for (const p of parts) {
      const pl = p.toLowerCase();
      if (pl.length >= 3 && !STOP.has(pl)) out.add(pl);
    }
  }
  return out;
}

// Field weights: where a term matched matters more than how often.
export const FIELD = { key: 3.0, anchor: 2.5, tag: 2.0, summary: 1.0 };

export function nodeTerms(n) {
  const fields = new Map(); // term -> best field weight
  const bump = (term, w) => {
    if (!term) return;
    const prev = fields.get(term) || 0;
    if (w > prev) fields.set(term, w);
  };
  for (const t of tokenizeKey(n.k)) bump(t, FIELD.key);
  for (const [name] of n.a || []) for (const t of tokenizeKey(name)) bump(t, FIELD.anchor);
  for (const g of n.g || []) bump(String(g).toLowerCase(), FIELD.tag);
  for (const t of tokenizeText(n.s || '')) bump(t, FIELD.summary);
  return fields;
}

export function buildIndex(dir, graph) {
  const postings = new Map(); // term -> [{id, w}]
  const alive = [...graph.nodes.values()].filter((n) => n.st !== 'dead');
  for (const n of alive) {
    for (const [term] of nodeTerms(n)) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push(n);
    }
  }

  const N = alive.length;
  const dfCap = Math.max(20, Math.floor(N * 0.15));
  const tagTerms = new Set();
  for (const n of alive) for (const g of n.g || []) tagTerms.add(String(g).toLowerCase());

  const lines = [];
  for (const term of [...postings.keys()].sort()) {
    const list = postings.get(term);
    if (list.length > dfCap && !tagTerms.has(term)) continue;
    const ids = list
      .slice()
      .sort((a, b) => (b.w || 1) - (a.w || 1) || a.id.localeCompare(b.id))
      .slice(0, POSTING_CAP)
      .map((n) => n.id)
      .sort();
    lines.push(term + '\t' + ids.join(','));
  }
  const text = lines.join('\n') + (lines.length ? '\n' : '');
  writeFileAtomic(path.join(dir, 'index', 'terms.tsv'), text);
  return { terms: lines.length, nodes: N };
}

export function loadIndex(dir) {
  const p = path.join(dir, 'index', 'terms.tsv');
  const map = new Map();
  if (!fs.existsSync(p)) return map;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    map.set(line.slice(0, tab), line.slice(tab + 1).split(','));
  }
  return map;
}

const TYPE_BOOST = {
  entry: 1.3, mod: 1.2, concept: 1.2, adr: 1.2, skill: 1.0,
  file: 1.0, issue: 1.0, note: 0.9, sym: 0.9,
};

export function search(graph, index, queryStr, opts = {}) {
  const qTerms = [...tokenizeText(queryStr), ...tokenizeKey(queryStr)];
  const terms = [...new Set(qTerms)].filter((t) => t.length >= 2);
  if (!terms.length) return { hits: [], terms };

  const N = Math.max(1, [...graph.nodes.values()].filter((n) => n.st !== 'dead').length);
  const candidates = new Map(); // id -> matched terms
  for (const term of terms) {
    const ids = index.get(term);
    if (!ids) continue;
    const idf = Math.log(1 + N / ids.length);
    for (const id of ids) {
      if (!candidates.has(id)) candidates.set(id, []);
      candidates.get(id).push({ term, idf });
    }
  }

  const scored = [];
  for (const [id, matches] of candidates) {
    const n = graph.nodes.get(id);
    if (!n || n.st === 'dead') continue;
    if (opts.type && n.t !== opts.type) continue;
    const fields = nodeTerms(n);
    let base = 0;
    for (const { term, idf } of matches) base += idf * (fields.get(term) || FIELD.summary);
    const coverage = 0.5 + 0.5 * (matches.length / terms.length);
    const boost = TYPE_BOOST[n.t] || 1;
    const weight = 1 + 0.1 * ((n.w || 1) - 1);
    const stale = n.st === 'stale' ? 0.8 : 1;
    scored.push({ node: n, score: base * coverage * boost * weight * stale });
  }

  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  return { hits: scored, terms };
}
