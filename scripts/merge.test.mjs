// Self-check for mergeIntoFileGraph. Run against any root holding both stores:
//   node merge.test.mjs [root]
// Asserts the property the merge exists to provide: the symbol graph's symbols are IN the
// file graph and reachable from its own nodes, so the file graph's viewer can draw one connected
// picture. A merge that appends a floating symbol cloud passes any count-based check and
// is worthless; this fails.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeIntoFileGraph } from './merge.mjs';

const root = path.resolve(process.argv[2] || process.cwd());
const filesDir = path.join(root, '.scope', 'files');
const symbolsDir = path.join(root, '.scope', 'symbols', 'index');
if (!fs.existsSync(path.join(filesDir, 'graph')) || !fs.existsSync(symbolsDir)) {
  console.log(`skip: ${root} has no paired stores (run: scope scan --root ${root})`);
  process.exit(0);
}

// The bundled engine, or the override the CLI honours. Diverging from findTool() here
// means the test can pass against an engine the CLI would never load.
const filesLib = [
  path.resolve(import.meta.dirname, '../engine/files/scripts/lib/store.mjs'),
  process.env.SCOPE_FILES && path.join(path.dirname(process.env.SCOPE_FILES), 'lib', 'store.mjs'),
].filter(Boolean).find((p) => fs.existsSync(p));
assert.ok(filesLib, 'file graph engine not found — cannot load the graph to merge into');
const { loadGraph } = await import(pathToFileURL(filesLib).href);

const graph = loadGraph(filesDir);
const fileNodes = graph.nodes.size;
const die = (m) => {
  throw new Error(m);
};
const stats = mergeIntoFileGraph({ fileGraph: graph, symbolsDir, die });

assert.ok(stats.symbols > 0, 'no symbols were added — the path join is broken');
assert.equal(graph.nodes.size, fileNodes + stats.symbols, 'node count does not match reported symbols');

// Every node the viewer will draw must satisfy its contract: loadGraph rejects a node
// without id/t/k, and the type/colour maps key off `t`.
const VALID_T = new Set(['entry', 'file', 'mod', 'sym', 'concept', 'adr', 'skill', 'note', 'issue']);
for (const n of graph.nodes.values()) {
  assert.ok(n.id && n.t && n.k !== undefined, `node missing id/t/k: ${JSON.stringify(n).slice(0, 80)}`);
  assert.ok(VALID_T.has(n.t), `node type "${n.t}" is not one the file graph's viewer knows`);
}

// Edge types must be ones the file graph's viewer understands, and both endpoints must exist --
// a dangling edge silently drops a symbol out of the picture.
const VALID_E = new Set([
  'imports', 'exports', 'part-of', 'tested-by', 'documents', 'calls',
  'blocks', 'closes', 'mentions', 'relates', 'implements',
]);
for (const e of graph.edges.values()) {
  assert.ok(VALID_E.has(e[1]), `edge type "${e[1]}" is not in the file graph's EDGE_TYPES`);
  assert.ok(graph.nodes.has(e[0]), `edge src ${e[0]} (${e[1]}) has no node`);
  assert.ok(graph.nodes.has(e[2]), `edge dst ${e[2]} (${e[1]}) has no node`);
}

// The walk that matters: a file node <- part-of - a symbol - calls -> another
// symbol. The file graph's tier and the symbol graph's tier, joined, in one graph.
const out = new Map();
for (const e of graph.edges.values()) {
  if (!out.has(e[0])) out.set(e[0], []);
  out.get(e[0]).push(e);
}
const chain = [...graph.nodes.values()]
  .filter((n) => n.t === 'sym')
  .map((sym) => {
    const file = (out.get(sym.id) || []).find((e) => e[1] === 'part-of' && graph.nodes.get(e[2])?.t === 'file');
    const call = (out.get(sym.id) || []).find((e) => e[1] === 'calls');
    return file && call && [file[2], sym.id, call[2]];
  })
  .find(Boolean);
assert.ok(chain, 'no file <- symbol -> calls path: the tiers are not joined');

const name = (id) => `${graph.nodes.get(id).t}(${graph.nodes.get(id).k})`;
console.log(`ok  ${fileNodes} file-graph nodes + ${stats.symbols} symbols = ${graph.nodes.size}`);
console.log(`ok  tiers joined: ${name(chain[0])} <- ${name(chain[1])} -> ${name(chain[2])}`);
