import { IMPACT_BUDGET_TOKENS, IMPACT_DEFAULT_DEPTH, estimateTokens } from './tokens.mjs';
import { moduleIdOfNode } from './query-store.mjs';

/**
 * Blast radius: upstream callers / downstream deps / affected tests for a symbol.
 *
 * Traversal edge types deliberately EXCLUDE `contains` (siblings of a symbol
 * are not part of its blast radius); test mapping is computed separately from
 * `tests` edges so tests surface for every direction.
 */
export const IMPACT_TRAVERSAL_TYPES = Object.freeze([
  'call',
  'import',
  'route',
  'extends',
  'implements',
]);

export const IMPACT_BUDGET = IMPACT_BUDGET_TOKENS;
/** Reserved headroom so the explicit truncation hint always fits inside the cap. */
export const IMPACT_HINT_RESERVE_TOKENS = 14;
export const TRUNCATION_HINT_SUFFIX = 'more (narrow with --depth N or filter)';

const STRENGTH = { exact: 2, heuristic: 1 };

function weaker(a, b) {
  return Math.min(STRENGTH[a] ?? 1, STRENGTH[b] ?? 1);
}

function pathStrength(curConf, edgeConf) {
  return weaker(curConf, edgeConf) === STRENGTH.exact ? 'exact' : 'heuristic';
}

function confRank(conf) {
  return -(STRENGTH[conf] ?? 1);
}

function byConfThenId(a, b) {
  return confRank(a.confidence) - confRank(b.confidence) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Traverse the graph from `targetId` following call/import/route/heritage
 * edges in the requested direction (`up`, `down`, or `both`).
 * Confidence along a path is the weakest edge on that path; a node keeps the
 * strongest confidence seen across all paths reaching it.
 *
 * Returns { direct: [{node, confidence}], transitive: [{node, confidence}],
 *           tests: [{path, confidence}] } — all deterministically sorted.
 */
export function collectImpact(store, targetId, direction = 'down', depth = IMPACT_DEFAULT_DEPTH) {
  const adjs =
    direction === 'up' ? [store.adjIn]
    : direction === 'both' ? [store.adjIn, store.adjOut]
    : [store.adjOut];

  const visited = new Map(); // id -> { hop, confidence }
  visited.set(targetId, { hop: 0, confidence: 'exact' });
  const queue = [[targetId, 0]];
  let head = 0;

  while (head < queue.length) {
    const [currentId, hop] = queue[head++];
    if (hop >= depth) continue;
    const curConf = visited.get(currentId).confidence;
    for (const adj of adjs) {
      for (const e of adj.get(currentId) ?? []) {
        if (!IMPACT_TRAVERSAL_TYPES.includes(e.type)) continue;
        const nextId = e.src === currentId ? e.dst : e.src;
        if (nextId === targetId || !store.nodesById.has(nextId)) continue;
        const nextConf = pathStrength(curConf, e.confidence);
        const prev = visited.get(nextId);
        if (!prev) {
          visited.set(nextId, { hop: hop + 1, confidence: nextConf });
          queue.push([nextId, hop + 1]);
        } else {
          if (hop + 1 < prev.hop) prev.hop = hop + 1;
          if (nextConf === 'exact' && prev.confidence !== 'exact') prev.confidence = 'exact';
        }
      }
    }
  }

  const target = store.nodesById.get(targetId);
  const direct = [];
  const transitive = [];
  for (const [id, info] of visited) {
    if (id === targetId) continue;
    const node = store.nodesById.get(id);
    if (!node) continue;
    (info.hop === 1 ? direct : transitive).push({ node, confidence: info.confidence });
  }
  direct.sort(byConfThenId);
  transitive.sort(byConfThenId);

  // Test mapping: test modules with a `tests` edge into any affected module.
  const affectedPaths = new Set([target.path]);
  for (const { node } of [...direct, ...transitive]) affectedPaths.add(node.path);
  const affectedModuleIds = new Set();
  for (const p of affectedPaths) {
    const modNode = store.moduleByPath.get(p);
    affectedModuleIds.add(modNode ? modNode.name : moduleIdOfNode({ path: p, lang: target.lang }));
  }
  const testsByPath = new Map();
  for (const e of store.edges) {
    if (e.type !== 'tests') continue;
    const dstNode = store.nodesById.get(e.dst);
    if (!dstNode || !affectedModuleIds.has(dstNode.name)) continue;
    const srcNode = store.nodesById.get(e.src);
    if (!srcNode) continue;
    const prev = testsByPath.get(srcNode.path);
    if (!prev || (prev !== 'exact' && e.confidence === 'exact')) testsByPath.set(srcNode.path, e.confidence);
  }
  const tests = [...testsByPath.entries()]
    .map(([testPath, confidence]) => ({ path: testPath, confidence }))
    .sort((a, b) => confRank(a.confidence) - confRank(b.confidence) || (a.path < b.path ? -1 : 1));

  return { direct, transitive, tests };
}

function groupByModule(items) {
  const groups = new Map();
  for (const item of items) {
    const mid = moduleIdOfNode(item.node);
    if (!groups.has(mid)) groups.set(mid, []);
    groups.get(mid).push(item);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([moduleId, members]) => ({ moduleId, members: members.sort(byConfThenId) }));
}

function directLine(item) {
  const s = item.node.span;
  return `  ${item.confidence} ${item.node.id} ${item.node.name} ${item.node.path}:${s.sl}-${s.el}`;
}

function transitiveLine(item) {
  return `    ${item.confidence} ${item.node.name} ${item.node.path}:${item.node.span.sl}`;
}

const TRANSITIVE_MEMBER_RE = /^ {4}/;

/**
 * Assemble the human-readable impact report under the hard token budget.
 *
 * Priority order: header/target -> direct -> tests -> transitive-by-module.
 * Every emitted byte goes through the shared estimator; overflow becomes an
 * explicit `+N more (...)` hint. The final text is asserted against the cap.
 */
export function assembleImpactReport(target, direction, impact, budgetTokens = IMPACT_BUDGET_TOKENS) {
  const dirLabel = direction === 'up' ? 'up' : direction === 'both' ? 'both' : 'down';
  let out =
    `impact ${target.id} ${target.name} [${dirLabel}]\n` +
    `def: ${target.path}:${target.span.sl}-${target.span.el} (${target.kind}, ${target.confidence})`;
  const limit = budgetTokens - IMPACT_HINT_RESERVE_TOKENS;

  const sections = [
    {
      title: `direct (${impact.direct.length})`,
      lines: impact.direct.map((d) => ({ text: directLine(d), isItem: true })),
      pending: impact.direct.length,
    },
    {
      title: `tests (${impact.tests.length})`,
      lines: impact.tests.map((t) => ({ text: `  ${t.confidence} ${t.path}`, isItem: true })),
      pending: impact.tests.length,
    },
  ];
  const transitiveLines = [];
  for (const g of groupByModule(impact.transitive)) {
    transitiveLines.push({ text: `  ${g.moduleId} (${g.members.length}):`, isItem: false });
    for (const m of g.members) transitiveLines.push({ text: transitiveLine(m), isItem: true });
  }
  sections.push({
    title: `transitive (${impact.transitive.length}, by module)`,
    lines: transitiveLines,
    pending: impact.transitive.length,
  });

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
    const hint = `\n+${skipped} ${TRUNCATION_HINT_SUFFIX}`;
    if (estimateTokens(out + hint) <= budgetTokens) out += hint;
    else {
      let lines = out.split('\n');
      while (lines.length > 0 && estimateTokens(lines.join('\n') + hint) > budgetTokens) lines.pop();
      out = lines.join('\n') + hint;
    }
  }

  if (
    impact.direct.length + impact.transitive.length + impact.tests.length === 0 &&
    estimateTokens(out + '\nno dependents found') <= budgetTokens
  ) {
    out += '\nno dependents found';
  }
  return out;
}
