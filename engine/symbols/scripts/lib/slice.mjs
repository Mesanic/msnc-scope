import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SLICE_DEFAULT_MAX_TOKENS, estimateTokens } from './tokens.mjs';
import { canonicalizeText } from './util.mjs';
import { UsageError } from './usage-error.mjs';

/** Refusal when the requested slice exceeds its token budget (never trimmed silently). */
export class SliceTooLargeError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'SliceTooLargeError';
    this.info = info;
  }
}

/**
 * Zoom expansion chain (per --expand step):
 *   enclosing function/method -> enclosing class/type -> file section
 *   (top-level declarations region). Uses `contains` edges from the store.
 * The file section is a stable terminal: further --expand steps are no-ops.
 */
export function expandTarget(store, target) {
  if (target.kind === 'span') return target;
  if (target.kind === 'range') {
    const container = smallestContainerAboveSpan(store, target.path, target.sl, target.el);
    return container ?? fileSectionSpan(store, target.path) ?? target;
  }
  const parentId = store.parents.get(target.node.id);
  const parent = parentId ? store.nodesById.get(parentId) : null;
  if (parent && parent.kind !== 'module') return { kind: 'node', node: parent };
  return fileSectionSpan(store, target.node.path) ?? target;
}

function spanOfDef(n) {
  return { sl: n.span.sl, el: n.span.el };
}

/** Smallest def strictly containing [sl, el] without being exactly equal to it. */
function smallestContainerAboveSpan(store, posixPath, sl, el) {
  let best = null;
  for (const n of store.nodes) {
    if (n.path !== posixPath || n.kind === 'module') continue;
    if (n.span.sl > sl || n.span.el < el) continue;
    if (n.span.sl === sl && n.span.el === el) continue;
    const size = n.span.el - n.span.sl;
    if (!best || size < best.size || (size === best.size && n.id < best.node.id)) {
      best = { node: n, size };
    }
  }
  return best ? { kind: 'node', node: best.node } : null;
}

function fileSectionSpan(store, posixPath) {
  let minSl = Infinity;
  let maxEl = 0;
  for (const n of store.nodes) {
    if (n.path !== posixPath || n.kind === 'module') continue;
    // Top-level decls only. Every top-level decl HAS a parent -- the module -- so a bare
    // truthiness test skipped all of them, leaving minSl at Infinity and forcing the
    // no-decls fallback on every file. Nest depth is what matters here: skip a node only
    // when its parent is another symbol. Same idiom as expandTarget above.
    const parentId = store.parents.get(n.id);
    if (parentId && store.nodesById.get(parentId)?.kind !== 'module') continue;
    minSl = Math.min(minSl, n.span.sl);
    maxEl = Math.max(maxEl, n.span.el);
  }
  if (!Number.isFinite(minSl)) {
    const modNode = store.moduleByPath.get(posixPath);
    if (!modNode) return null;
    return { kind: 'span', path: posixPath, sl: 1, el: modNode.span.el, symbol: null };
  }
  return { kind: 'span', path: posixPath, sl: minSl, el: maxEl, symbol: null };
}

export async function readSourceLines(rootAbs, posixPath) {
  const raw = await readFile(path.join(rootAbs, ...posixPath.split('/')), 'utf8');
  return canonicalizeText(raw).split('\n');
}

function clampRange(sl, el, lineCount) {
  const clampedSl = Math.max(1, sl);
  const clampedEl = Math.min(el, lineCount);
  return { sl: clampedSl, el: Math.max(clampedSl, clampedEl) };
}

/**
 * Build a slice: 3-line header (file / span / symbol), separator, verbatim
 * source lines. Refuses (SliceTooLargeError) instead of trimming silently.
 */
export function buildSlice(lines, targetInfo, maxTokens = SLICE_DEFAULT_MAX_TOKENS) {
  const { path: posixPath, sl, el } = targetInfo;
  const { sl: csl, el: cel } = clampRange(sl, el, lines.length);
  const body = lines.slice(csl - 1, cel).join('\n');

  const header = [
    `file: ${posixPath}`,
    `span: ${csl}-${cel}`,
    `symbol: ${targetInfo.symbol ? `${targetInfo.symbol.name} (${targetInfo.symbol.kind}, ${targetInfo.symbol.confidence})` : '-'}`,
  ];
  const text = `${header.join('\n')}\n---\n${body}`;
  const tokens = estimateTokens(text);
  if (tokens > maxTokens) {
    throw new SliceTooLargeError(
      `slice of ${posixPath}:${sl}-${el} is ~${tokens} tokens, over the ${maxTokens}-token budget; ` +
        'narrow the line range or raise --max-tokens',
      { tokens, maxTokens },
    );
  }
  return { text, span: { sl: csl, el: cel }, header };
}
