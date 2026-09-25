import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BRIEF_BUDGET_TOKENS, estimateTokens } from './tokens.mjs';
import { collectImpact, IMPACT_TRAVERSAL_TYPES } from './impact.mjs';
import { canonicalizeText } from './util.mjs';

const PREVIEW_LINE_CHARS = 60;
const PREVIEW_MAX_LINES = 3;
const MAX_TESTS_SHOWN = 2;

function countRefs(store, nodeId) {
  let up = 0;
  let down = 0;
  const adjIn = store.adjIn.get(nodeId) ?? [];
  const adjOut = store.adjOut.get(nodeId) ?? [];
  for (const e of adjIn) {
    if (IMPACT_TRAVERSAL_TYPES.includes(e.type)) up += 1;
  }
  for (const e of adjOut) {
    if (IMPACT_TRAVERSAL_TYPES.includes(e.type)) down += 1;
  }
  return { up, down };
}

function confSplit(store, nodeId) {
  const counts = { exact: 0, heuristic: 0 };
  for (const e of [...(store.adjIn.get(nodeId) ?? []), ...(store.adjOut.get(nodeId) ?? [])]) {
    if (IMPACT_TRAVERSAL_TYPES.includes(e.type)) counts[e.confidence] = (counts[e.confidence] ?? 0) + 1;
  }
  return counts;
}

function testPathsFor(store, node) {
  const modNode = store.moduleByPath.get(node.path);
  if (!modNode) return [];
  const out = new Set();
  for (const e of store.edges) {
    if (e.type !== 'tests' || e.dst !== modNode.id) continue;
    const src = store.nodesById.get(e.src);
    if (src) out.add(src.path);
    if (out.size >= MAX_TESTS_SHOWN) break;
  }
  return [...out].sort();
}

/**
 * Compact orientation card (≤ BRIEF_BUDGET_TOKENS): definition span,
 * signature, direct up/down ref counts, top tests, 3-line slice preview.
 * Degrades deterministically — the head block itself is budget-clamped
 * (tests line drops first, then the def path clips), preview lines go next,
 * sig truncation last.
 */
export async function buildBrief(store, rootAbs, target) {
  const node = target.node;
  const refs = countRefs(store, node.id);
  const splits = confSplit(store, node.id);
  const tests = testPathsFor(store, node);

  const budget = BRIEF_BUDGET_TOKENS;
  const fits = (arr) => estimateTokens(arr.join('\n')) <= budget;

  // Head block clamp: deep def paths and long test lists must not blow the
  // advertised card budget before any degrade logic runs. Order: drop the
  // tests line first, then clip leading directory segments off the def path,
  // then character-clip that tail as a last resort. Deterministic.
  const briefLine = `brief ${node.name} ${node.id}`;
  const refsLine = `refs: up=${refs.up} down=${refs.down} (exact=${splits.exact ?? 0}, heuristic=${splits.heuristic ?? 0})`;
  const defLine = (p) => `def: ${p}:${node.span.sl}-${node.span.el} (${node.kind}, ${node.confidence})`;
  let head = [briefLine, defLine(node.path), refsLine];
  if (tests.length > 0) {
    const withTests = [...head, `tests: ${tests.join(', ')}`];
    if (fits(withTests)) head = withTests;
  }
  if (!fits(head)) {
    const parts = node.path.split('/');
    const withPath = (tail) => [head[0], defLine(tail), head[2]];
    let idx = 0;
    while (idx < parts.length - 1 && !fits(withPath(`…/${parts.slice(idx + 1).join('/')}`))) idx += 1;
    let tail = idx < parts.length - 1 ? `…/${parts.slice(idx + 1).join('/')}` : parts[parts.length - 1];
    if (!fits(withPath(tail))) {
      let keep = tail.length;
      while (keep > 1 && !fits(withPath(`…${tail.slice(tail.length - keep)}`))) keep -= Math.max(1, Math.floor(keep / 8));
      tail = `…${tail.slice(tail.length - keep)}`;
      while (tail.length > 1 && !fits(withPath(tail))) tail = `…${tail.slice(2)}`;
    }
    head = withPath(tail);
  }

  const lines = [...head];

  const sig = typeof node.sig === 'string' ? node.sig : '';
  const previewRaw = await slicePreview(rootAbs, node);

  let candidate = [...lines];
  if (sig && fits([...candidate, `sig: ${sig}`])) candidate.push(`sig: ${sig}`);
  else if (sig) {
    // degrade: truncate the signature until it fits
    let keep = Math.max(0, sig.length - 1);
    while (keep > 4) {
      const attempt = `sig: ${sig.slice(0, keep)}…`;
      if (fits([...lines, attempt])) {
        candidate.push(attempt);
        break;
      }
      keep -= Math.max(1, Math.floor(keep / 8));
    }
  }

  for (let n = previewRaw.length; n > 0; n--) {
    const withPreview = [...candidate, ...previewRaw.slice(0, n)];
    if (fits(withPreview)) {
      candidate = withPreview;
      break;
    }
  }

  return candidate.join('\n');
}

async function slicePreview(rootAbs, node) {
  let text;
  try {
    text = await readFile(path.join(rootAbs, ...node.path.split('/')), 'utf8');
  } catch {
    return [];
  }
  const allLines = canonicalizeText(text).split('\n');
  const out = [];
  for (let i = node.span.sl; i <= node.span.sl + PREVIEW_MAX_LINES - 1 && i <= node.span.el; i++) {
    const rawLine = (allLines[i - 1] ?? '').trim().slice(0, PREVIEW_LINE_CHARS);
    out.push(`  ${i}: ${rawLine}`);
  }
  return out;
}
