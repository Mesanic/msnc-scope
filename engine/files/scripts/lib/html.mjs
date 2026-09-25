// graph-html: embed the graph plus overlays into the viewer template as one self-contained page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesDir, fail, loadConfig, readJsonIfExists, writeFileAtomic } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, '..', 'viewer-template.html');
const SLOT = '/*__SCOPE_DATA__*/';

// `outFile` lets a caller render a graph that is not exactly this store's own -- Scope
// passes a graph with the symbol graph's symbol tier folded in, and must not clobber the view
// `scope view` writes. Omitted, behaviour is unchanged.
export function graphHtml(ctx, graph, outFile) {
  const dir = filesDir(ctx.root);
  const config = loadConfig(dir);
  if (!fs.existsSync(TEMPLATE)) fail(`viewer template missing at ${TEMPLATE}`);
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  if (!template.includes(SLOT)) fail('viewer template has no data slot');

  const git = readJsonIfExists(path.join(dir, 'overlays', 'git.json'));
  const issues = readJsonIfExists(path.join(dir, 'overlays', 'issues.json'));

  const alive = [...graph.nodes.values()].filter((n) => n.st !== 'dead');
  const payload = {
    meta: {
      name: config.name || path.basename(ctx.root),
      repo: issues ? issues.repo : null,
      generated: new Date().toISOString(),
    },
    // src/chk/note are only present when a caller folded another store in (Scope does);
    // emitted only when set so a plain `scope view` payload is unchanged.
    nodes: alive.map((n) => {
      const out = {
        id: n.id, t: n.t, k: n.k, s: n.s || '', g: n.g || [],
        w: n.w || 1, st: n.st || null, a: n.a || [], by: n.by || 'scan',
      };
      if (n.src) out.src = n.src;
      if (n.chk) out.chk = n.chk;
      if (n.note) out.note = n.note;
      return out;
    }),
    edges: [...graph.edges.values()].map((e) => [e[0], e[1], e[2]]),
    git,
    issues,
  };

  // The payload rides inside a <script> element, so any "</script>" or "<!--" sequence in a
  // summary would end the block early. Escaping "<" as < keeps it valid JSON and inert HTML.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const html = template.replace(SLOT, json);
  const target = outFile || path.join(dir, 'view', 'scope.html');
  writeFileAtomic(target, html);

  return {
    file: target,
    nodes: payload.nodes.length,
    edges: payload.edges.length,
    bytes: Buffer.byteLength(html, 'utf8'),
    hasGit: !!git,
    hasIssues: !!issues,
  };
}
