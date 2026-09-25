// Graph traversal: adjacency, flow position, neighbors, paths, and the context card.
//
// Direction vocabulary used everywhere (labelled explicitly in output, never assumed):
//   "reached by" / upstream   = files that import this, transitively, back to entrypoints.
//                               These are what break if this changes.
//   "depends on" / downstream = what this file imports, transitively.
import path from 'node:path';
import { filesDir, readJsonIfExists, truncate } from './store.mjs';

const FLOW_EDGES = new Set(['imports', 'calls']);

export function adjacency(graph) {
  const out = new Map();
  const inc = new Map();
  for (const e of graph.edges.values()) {
    const [s, t, d] = e;
    if (!out.has(s)) out.set(s, []);
    out.get(s).push([t, d]);
    if (!inc.has(d)) inc.set(d, []);
    inc.get(d).push([t, s]);
  }
  return { out, inc };
}

export function flowGraph(graph) {
  const fwd = new Map();
  const rev = new Map();
  for (const [s, t, d] of graph.edges.values()) {
    if (!FLOW_EDGES.has(t)) continue;
    if (!fwd.has(s)) fwd.set(s, new Set());
    fwd.get(s).add(d);
    if (!rev.has(d)) rev.set(d, new Set());
    rev.get(d).add(s);
  }
  return { fwd, rev };
}

// Roots of the flow DAG: declared entrypoints plus anything nothing imports.
export function flowRoots(graph, flow) {
  const roots = [];
  for (const n of graph.nodes.values()) {
    if (n.st === 'dead') continue;
    if (!['file', 'entry', 'adr', 'mod'].includes(n.t)) continue;
    const hasIn = flow.rev.has(n.id) && flow.rev.get(n.id).size > 0;
    const hasOut = flow.fwd.has(n.id) && flow.fwd.get(n.id).size > 0;
    if (n.t === 'entry' || (!hasIn && hasOut)) roots.push(n.id);
  }
  return roots;
}

export function flowDepth(graph, flow) {
  const depth = new Map();
  const queue = flowRoots(graph, flow);
  for (const id of queue) depth.set(id, 0);
  for (let i = 0; i < queue.length; i += 1) {
    const cur = queue[i];
    const d = depth.get(cur);
    for (const next of flow.fwd.get(cur) || []) {
      if (depth.has(next)) continue;
      depth.set(next, d + 1);
      queue.push(next);
    }
  }
  return depth;
}

export function degrees(graph, flow) {
  const map = new Map();
  for (const id of graph.nodes.keys()) {
    map.set(id, {
      in: (flow.rev.get(id) || new Set()).size,
      out: (flow.fwd.get(id) || new Set()).size,
    });
  }
  return map;
}

export function reachable(flow, startId, dir, limit = 4000) {
  const edges = dir === 'up' ? flow.rev : flow.fwd;
  const seen = new Set([startId]);
  const order = [];
  const queue = [startId];
  while (queue.length && order.length < limit) {
    const cur = queue.shift();
    for (const next of edges.get(cur) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      order.push(next);
      queue.push(next);
    }
  }
  return order;
}

// The most explanatory chain from a flow root down to the node (bounded DFS on the reverse graph).
// A path that starts at a declared entrypoint always beats a longer one that does not: "this is
// reached from src/index.ts" is the answer someone wants, and a test file importing the module is
// technically an upstream root but explains nothing about how the program runs.
export function longestUpPath(flow, targetId, isEntry = () => false, maxDepth = 12) {
  let best = [targetId];
  let bestScore = -1;
  const stack = [[targetId, [targetId], new Set([targetId])]];
  let steps = 0;
  while (stack.length && steps < 20000) {
    steps += 1;
    const [cur, pathSoFar, seen] = stack.pop();
    const parents = [...(flow.rev.get(cur) || [])].filter((p) => !seen.has(p));
    if (!parents.length || pathSoFar.length >= maxDepth) {
      const score = (isEntry(cur) ? 1000 : 0) + pathSoFar.length;
      if (score > bestScore) { bestScore = score; best = pathSoFar; }
      continue;
    }
    for (const p of parents) {
      const next = new Set(seen);
      next.add(p);
      stack.push([p, [...pathSoFar, p], next]);
    }
  }
  return best.slice().reverse(); // root .. target
}

export function neighbors(graph, id, opts = {}) {
  const depth = Math.min(3, Math.max(1, opts.depth || 1));
  const dir = opts.dir || 'both';
  const adj = adjacency(graph);
  const seen = new Set([id]);
  const levels = [];
  let frontier = [id];
  for (let d = 0; d < depth; d += 1) {
    const groups = new Map();
    const next = [];
    for (const cur of frontier) {
      if (dir !== 'in') {
        for (const [type, dst] of adj.out.get(cur) || []) {
          if (opts.type && type !== opts.type) continue;
          if (seen.has(dst)) continue;
          seen.add(dst);
          next.push(dst);
          if (!groups.has(type)) groups.set(type, []);
          groups.get(type).push({ id: dst, dir: 'out' });
        }
      }
      if (dir !== 'out') {
        for (const [type, src] of adj.inc.get(cur) || []) {
          if (opts.type && type !== opts.type) continue;
          if (seen.has(src)) continue;
          seen.add(src);
          next.push(src);
          if (!groups.has(type)) groups.set(type, []);
          groups.get(type).push({ id: src, dir: 'in' });
        }
      }
    }
    if (!groups.size) break;
    levels.push(groups);
    frontier = next;
  }
  return levels;
}

export function findPath(graph, a, b, maxHops = 6) {
  if (a === b) return [a];
  const adj = adjacency(graph);
  const link = (id) => [
    ...(adj.out.get(id) || []).map(([t, d]) => [t, d, '→']),
    ...(adj.inc.get(id) || []).map(([t, s]) => [t, s, '←']),
  ];
  const fromA = new Map([[a, null]]);
  const fromB = new Map([[b, null]]);
  let qa = [a];
  let qb = [b];
  for (let hop = 0; hop < maxHops; hop += 1) {
    for (const [queue, side, other] of [[qa, fromA, fromB], [qb, fromB, fromA]]) {
      const next = [];
      for (const cur of queue) {
        for (const [type, dst, arrow] of link(cur)) {
          if (side.has(dst)) continue;
          side.set(dst, { prev: cur, type, arrow });
          if (other.has(dst)) return stitch(fromA, fromB, dst);
          next.push(dst);
        }
      }
      if (side === fromA) qa = next; else qb = next;
    }
    if (!qa.length && !qb.length) break;
  }
  return null;
}

function stitch(fromA, fromB, meet) {
  const left = [];
  let cur = meet;
  while (fromA.get(cur)) { const s = fromA.get(cur); left.unshift({ id: cur, type: s.type, arrow: s.arrow }); cur = s.prev; }
  left.unshift({ id: cur, type: null, arrow: null });
  const right = [];
  cur = meet;
  while (fromB.get(cur)) { const s = fromB.get(cur); cur = s.prev; right.push({ id: cur, type: s.type, arrow: s.arrow === '→' ? '←' : '→' }); }
  return [...left, ...right];
}

export function loadOverlays(root) {
  const dir = filesDir(root);
  return {
    git: readJsonIfExists(path.join(dir, 'overlays', 'git.json')),
    issues: readJsonIfExists(path.join(dir, 'overlays', 'issues.json')),
  };
}

export function gitStateOf(overlays, key) {
  if (!overlays.git) return null;
  if (overlays.git.files && overlays.git.files[key]) return overlays.git.files[key];
  return overlays.git.default || null;
}

function modOf(key) { return key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '.'; }

export function contextCard(graph, node, overlays) {
  const flow = flowGraph(graph);
  const adj = adjacency(graph);
  const deg = degrees(graph, flow);
  const depth = flowDepth(graph, flow);
  const name = (id) => {
    const n = graph.nodes.get(id);
    return n ? n.k : id;
  };

  const upAll = reachable(flow, node.id, 'up');
  const downAll = reachable(flow, node.id, 'down');
  const upDirect = [...(flow.rev.get(node.id) || [])];
  const downDirect = [...(flow.fwd.get(node.id) || [])];
  const chain = longestUpPath(flow, node.id, (id) => {
    const n = graph.nodes.get(id);
    return !!n && n.t === 'entry';
  });

  const byModule = (ids) => {
    const m = new Map();
    for (const id of ids) {
      const n = graph.nodes.get(id);
      if (!n) continue;
      const key = n.t === 'mod' ? n.k : modOf(n.k);
      m.set(key, (m.get(key) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };

  const rel = { tests: [], docs: [], covers: [], issues: [], concepts: [], siblings: [], symbols: [] };
  for (const [type, dst] of adj.out.get(node.id) || []) {
    const n = graph.nodes.get(dst);
    if (!n) continue;
    if (type === 'tested-by') rel.tests.push(n);
    else if (type === 'documents') rel.covers.push(n);
    else if (type === 'exports') rel.symbols.push(n);
    else if (type === 'closes' || type === 'mentions') { if (n.t === 'issue') rel.issues.push(n); }
    else if (type === 'implements' || type === 'relates') rel.concepts.push(n);
  }
  for (const [type, src] of adj.inc.get(node.id) || []) {
    const n = graph.nodes.get(src);
    if (!n) continue;
    if (type === 'documents') rel.docs.push(n);
    else if (type === 'mentions' && n.t === 'issue') rel.issues.push(n);
    else if (type === 'relates' || type === 'implements') rel.concepts.push(n);
  }

  const myMod = node.t === 'mod' ? node.k : modOf(node.k);
  for (const n of graph.nodes.values()) {
    if (n.id === node.id || n.st === 'dead') continue;
    if (!['file', 'entry', 'adr'].includes(n.t)) continue;
    if (modOf(n.k) === myMod) rel.siblings.push(n);
  }
  rel.siblings.sort((a, b) => a.k.localeCompare(b.k));

  return {
    node,
    git: gitStateOf(overlays, node.k),
    depth: depth.has(node.id) ? depth.get(node.id) : null,
    degree: deg.get(node.id) || { in: 0, out: 0 },
    chain: chain.length > 1 ? chain.map(name) : [],
    chainRooted: chain.length > 1 && (graph.nodes.get(chain[0]) || {}).t === 'entry',
    upDirect: upDirect.map(name).sort(),
    upCount: upAll.length,
    upModules: byModule(upAll),
    downDirect: downDirect.map(name).sort(),
    downCount: downAll.length,
    downModules: byModule(downAll),
    rel,
    issueState: overlays.issues ? overlays.issues.issues : null,
  };
}

export function verify(graph, root, hashOf) {
  const stale = [];
  const dead = [];
  const ok = [];
  for (const n of graph.nodes.values()) {
    if (!['file', 'entry', 'adr', 'sym'].includes(n.t)) continue;
    const filePath = n.t === 'sym' ? n.k.split('#')[0] : n.k;
    const h = hashOf(filePath);
    if (h === null) { dead.push(n); continue; }
    if (n.h && n.h !== h) { stale.push(n); n.st = 'stale'; } else if (n.st === 'stale') { ok.push(n); }
  }
  return { stale, dead, ok };
}

export function summarizeLine(n, extra = {}) {
  const bits = [n.id, n.t, n.k];
  if (n.st) bits.push(`[${n.st}]`);
  if (extra.git && extra.git !== 'pushed') bits.push(`[${extra.git}]`);
  const flow = [];
  if (extra.degree) {
    if (extra.degree.in) flow.push(`in:${extra.degree.in}`);
    if (extra.degree.out) flow.push(`out:${extra.degree.out}`);
  }
  if (extra.depth !== null && extra.depth !== undefined) flow.push(`d:${extra.depth}`);
  if (flow.length) bits.push(flow.join(' '));
  return bits.join(' ') + ' :: ' + truncate(n.s || '', 200);
}
