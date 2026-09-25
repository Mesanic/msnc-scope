#!/usr/bin/env node
// files engine — persistent codebase knowledge graph. See the scope SKILL.md for the agent protocol.
import fs from 'node:fs';
import path from 'node:path';
import {
  addEdge, addNode, filesDir, ScopeError, EDGE_TYPES, estTokens, fail, findRoot, idFor,
  loadConfig, loadGraph, normalizeLF, NODE_TYPES, removeNode, saveGraph, sha8, truncate,
} from './lib/store.mjs';
import { checkSelfDrift, expand, init as initStore, scan } from './lib/scan.mjs';
import { buildIndex, loadIndex, search } from './lib/index.mjs';
import { gitOverlay } from './lib/git.mjs';
import { linkIssues, syncIssues } from './lib/issues.mjs';
import { graphHtml } from './lib/html.mjs';
import {
  adjacency, contextCard, degrees, findPath, flowDepth, flowGraph, gitStateOf, loadOverlays,
  neighbors, summarizeLine, verify,
} from './lib/graphops.mjs';

const out = [];
const say = (line = '') => out.push(line);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else positional.push(a);
  }
  return { positional, flags };
}

function ctxFor() {
  const root = findRoot();
  return { root, dir: filesDir(root) };
}

function requireStore(ctx) {
  if (!fs.existsSync(ctx.dir)) {
    fail('this repo is not indexed yet — run `scope scan`');
  }
  const graph = loadGraph(ctx.dir);
  for (const w of graph.warnings) say(`warn: ${w}`);
  return graph;
}

function hashOfFile(root, rel) {
  try {
    const buf = fs.readFileSync(path.join(root, rel));
    return sha8(normalizeLF(buf.toString('utf8')));
  } catch { return null; }
}

function resolveNode(graph, ref) {
  if (graph.nodes.has(ref)) return graph.nodes.get(ref);
  const key = ref.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const t of ['entry', 'file', 'adr', 'mod', 'sym', 'concept', 'note', 'issue', 'skill']) {
    const n = graph.byKey.get(t + ':' + key);
    if (n) return n;
  }
  const matches = [...graph.nodes.values()].filter((n) => n.k === key || n.k.endsWith('/' + key));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) fail(`"${ref}" matches ${matches.length} nodes: ${matches.slice(0, 5).map((m) => m.k).join(', ')}`);
  fail(`no node for "${ref}" — try \`scope query "${ref}"\``);
  return null;
}

// --- commands --------------------------------------------------------------

const COMMANDS = {};

COMMANDS.init = {
  help: 'init — create the file graph store and gitignore entries (use `scope scan`)',
  run(ctx) {
    const r = initStore(ctx);
    say(r.created.length ? `created:\n  ${r.created.join('\n  ')}` : 'already initialized — nothing to do');
    if (!r.gitOk) say('warn: not a git repository — push state and issue sync are unavailable');
    say('\nnext: scope scan');
  },
};

COMMANDS.scan = {
  help: 'scope scan [--full] — index files, edges and anchors; regenerate MAP.md sections',
  run(ctx, args) {
    const r = scan(ctx, args.raw);
    for (const w of r.warnings) say(`warn: ${w}`);
    const drift = checkSelfDrift(Object.keys(COMMANDS));
    if (drift) say(`warn: ${drift}`);
    say(`scanned ${r.files} files — ${r.new} new, ${r.changed} changed, ${r.kept} unchanged, ${r.dead} dead`);
    say(`graph: ${r.nodes} nodes, ${r.edges} edges, ${r.terms} index terms`);
    const s = r.skipped;
    const sk = [s.ignored && `${s.ignored} ignored`, s.skill && `${s.skill} in skill trees`,
      s.big && `${s.big} too large`, s.binary && `${s.binary} binary`].filter(Boolean);
    if (sk.length) say(`skipped: ${sk.join(', ')}`);
    if (r.unresolved.count) say(`unresolved local imports: ${r.unresolved.count} (see references/ALGORITHMS.md)`);
  },
};

COMMANDS.index = {
  help: 'scope index — rebuild the inverted index from the graph',
  run(ctx) {
    const graph = requireStore(ctx);
    const r = buildIndex(ctx.dir, graph);
    say(`indexed ${r.nodes} nodes into ${r.terms} terms`);
  },
};

COMMANDS.query = {
  help: 'scope query "terms" [--type T] [--k N] [--budget TOKENS] — ranked retrieval',
  run(ctx, args) {
    const graph = requireStore(ctx);
    const q = args.positional.join(' ').trim();
    if (!q) fail('usage: scope query "search terms"');
    const config = loadConfig(ctx.dir);
    let index = loadIndex(ctx.dir);
    if (!index.size) { buildIndex(ctx.dir, graph); index = loadIndex(ctx.dir); }

    const { hits } = search(graph, index, q, { type: args.flags.type });
    if (!hits.length) {
      say(`no hits for "${q}".`);
      say('broaden the terms, or Grep for it and then record what you find:');
      say('  scope note file add --type concept --key <slug> --summary "..." ');
      return;
    }

    const flow = flowGraph(graph);
    const deg = degrees(graph, flow);
    const depth = flowDepth(graph, flow);
    const adj = adjacency(graph);
    const overlays = loadOverlays(ctx.root);
    const limit = Number(args.flags.k || 10);
    const budget = Number(args.flags.budget || config.budgets.query_tokens);

    say(`${hits.length} hit${hits.length === 1 ? '' : 's'} for "${q}"`);
    let used = 0;
    let shown = 0;
    for (const { node } of hits) {
      if (shown >= limit) break;
      const line = summarizeLine(node, {
        degree: deg.get(node.id),
        depth: depth.has(node.id) ? depth.get(node.id) : null,
        git: gitStateOf(overlays, node.k),
      });
      const edges = (adj.out.get(node.id) || []).slice(0, 3)
        .map(([t, d]) => `${t}→${short(graph, d)}`).join(' · ');
      const block = line + (edges ? `\n    ${edges}` : '');
      used += estTokens(block.length);
      if (used > budget && shown > 0) { say(`… ${hits.length - shown} more (raise --budget or narrow --type)`); break; }
      say(block);
      shown += 1;
    }
    say(`\nnext: scope context <id> for the full upstream/downstream picture`);
  },
};

COMMANDS.context = {
  help: 'scope context <id|path> — one card: upstream, downstream, impact, tests, docs, issues, git',
  run(ctx, args) {
    const graph = requireStore(ctx);
    const ref = args.positional[0];
    if (!ref) fail('usage: scope context <id|path>');
    const node = resolveNode(graph, ref);
    const overlays = loadOverlays(ctx.root);
    const c = contextCard(graph, node, overlays);

    const head = [node.id, node.t, node.k];
    if (node.st) head.push(`[${node.st}]`);
    if (c.git && c.git !== 'pushed') head.push(`[git:${c.git}]`);
    if (c.depth !== null) head.push(`depth:${c.depth}`);
    if (node.by === 'agent') head.push('(agent summary)');
    say(head.join(' '));
    say(node.s || '(no summary)');
    if (node.g && node.g.length) say(`tags: ${node.g.join(', ')}`);
    say('');

    if (c.chain.length > 1) {
      const hops = c.chain.length - 1;
      say(`REACHED BY (${hops} hop${hops === 1 ? '' : 's'} from ${c.chainRooted ? 'entrypoint' : 'a root'}):`);
      say('  ' + c.chain.join('\n    → '));
    }
    if (c.upDirect.length) {
      say(`IMPORTED BY (direct): ${c.upDirect.slice(0, 8).join(', ')}${c.upDirect.length > 8 ? ` (+${c.upDirect.length - 8})` : ''}`);
    }
    if (c.upCount) {
      say(`IMPACT if this changes: ${c.upCount} file${c.upCount === 1 ? '' : 's'} across ${c.upModules.slice(0, 4).map(([m, n]) => `${m} (${n})`).join(', ')}`);
    }
    if (!c.chain.length && !c.upCount) say('REACHED BY: nothing imports this (a root, or not reachable via static imports)');
    say('');

    if (c.downDirect.length) {
      say(`DEPENDS ON (direct): ${c.downDirect.slice(0, 8).join(', ')}${c.downDirect.length > 8 ? ` (+${c.downDirect.length - 8})` : ''}`);
      if (c.downCount > c.downDirect.length) {
        say(`  transitively ${c.downCount} across ${c.downModules.slice(0, 4).map(([m, n]) => `${m} (${n})`).join(', ')}`);
      }
    } else say('DEPENDS ON: nothing (leaf)');

    const r = c.rel;
    if (r.tests.length) say(`TESTS: ${r.tests.map((n) => n.k).join(', ')}`);
    if (r.docs.length) say(`DOCS: ${r.docs.map((n) => n.k).join(', ')}`);
    if (r.covers.length) {
      say(`COVERS: ${r.covers.slice(0, 8).map((n) => n.k).join(', ')}${r.covers.length > 8 ? ` (+${r.covers.length - 8})` : ''}`);
    }
    if (r.concepts.length) say(`RELATED: ${r.concepts.map((n) => `${n.k} (${n.id})`).join(', ')}`);
    if (r.issues.length) {
      const parts = r.issues.map((n) => {
        const st = c.issueState && c.issueState[n.k.replace('#', '')];
        if (!st) return n.k;
        const blocked = st.openBlockedBy && st.openBlockedBy.length ? ` blocked by #${st.openBlockedBy.join(', #')}` : '';
        return `${n.k} ${st.state}${blocked}`;
      });
      say(`ISSUES: ${parts.join(' · ')}`);
    }
    if (r.siblings.length) {
      say(`SIBLINGS: ${r.siblings.slice(0, 6).map((n) => n.k.slice(n.k.lastIndexOf('/') + 1)).join(', ')}${r.siblings.length > 6 ? ` (+${r.siblings.length - 6})` : ''}`);
    }
    if (node.a && node.a.length) {
      say(`ANCHORS: ${node.a.map(([n, l]) => `${n}:${l}`).join(', ')}`);
      say(`  read a symbol with Read offset/limit around its line instead of the whole file`);
    }
  },
};

COMMANDS.neighbors = {
  help: 'scope neighbors <id> [--depth 1-3] [--dir in|out|both] [--type T] — adjacency by edge type',
  run(ctx, args) {
    const graph = requireStore(ctx);
    const node = resolveNode(graph, args.positional[0] || fail('usage: scope neighbors <id>'));
    const levels = neighbors(graph, node.id, {
      depth: Number(args.flags.depth || 1),
      dir: args.flags.dir,
      type: args.flags.type,
    });
    say(`${node.id} ${node.t} ${node.k}`);
    if (!levels.length) { say('  (no edges)'); return; }
    let used = 0;
    levels.forEach((groups, i) => {
      say(`\n-- depth ${i + 1} --`);
      for (const [type, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
        const items = list.map(({ id, dir }) => `${dir === 'out' ? '→' : '←'}${short(graph, id)}`);
        const line = `${type}: ${items.slice(0, 12).join(', ')}${items.length > 12 ? ` (+${items.length - 12})` : ''}`;
        used += estTokens(line.length);
        if (used > 1200) { say('… truncated at ~1200 tokens; narrow with --type'); return; }
        say(line);
      }
    });
  },
};

COMMANDS.path = {
  help: 'scope path <a> <b> — how two nodes connect (up to 6 hops, any edge type)',
  run(ctx, args) {
    const graph = requireStore(ctx);
    const a = resolveNode(graph, args.positional[0] || fail('usage: scope path <a> <b>'));
    const b = resolveNode(graph, args.positional[1] || fail('usage: scope path <a> <b>'));
    const p = findPath(graph, a.id, b.id);
    if (!p) { say(`no path within 6 hops between ${a.k} and ${b.k}`); return; }
    say(p.map((step, i) => (i === 0 ? short(graph, step.id) : ` -${step.type}${step.arrow} ${short(graph, step.id)}`)).join(''));
  },
};

COMMANDS.verify = {
  help: 'scope verify — detect summaries that drifted from their file (stale) and vanished files (dead)',
  run(ctx) {
    const graph = requireStore(ctx);
    const r = verify(graph, ctx.root, (rel) => hashOfFile(ctx.root, rel));
    if (r.stale.length) {
      say(`stale (${r.stale.length}) — content changed since the summary was written:`);
      for (const n of r.stale.slice(0, 20)) say(`  ${n.id} ${n.k}${n.by === 'agent' ? ' (agent summary — re-bless after reading)' : ''}`);
      if (r.stale.length > 20) say(`  … +${r.stale.length - 20}`);
    }
    if (r.dead.length) {
      say(`dead (${r.dead.length}) — file no longer exists:`);
      for (const n of r.dead.slice(0, 20)) say(`  ${n.id} ${n.k}`);
      say('  run `scope prune` to remove them');
    }
    if (!r.stale.length && !r.dead.length) say('clean — every node matches its file');
    else saveGraph(ctx.dir, graph);
    const drift = checkSelfDrift(Object.keys(COMMANDS));
    if (drift) say(`warn: ${drift}`);
  },
};

COMMANDS.prune = {
  help: 'scope prune [--dry-run] — remove dead nodes, orphan edges and duplicates; flag oversized summaries',
  run(ctx, args) {
    const graph = requireStore(ctx);
    const config = loadConfig(ctx.dir);
    const dry = args.flags['dry-run'] === true || args.flags.dry === true;
    const dead = [...graph.nodes.values()].filter((n) => {
      if (n.st === 'dead') return true;
      if (['file', 'entry', 'adr'].includes(n.t)) return hashOfFile(ctx.root, n.k) === null;
      if (n.t === 'sym') return hashOfFile(ctx.root, n.k.split('#')[0]) === null;
      return false;
    });
    const orphans = [];
    for (const [key, e] of graph.edges) {
      if (!graph.nodes.has(e[0]) || !graph.nodes.has(e[2])) orphans.push(key);
    }
    const oversized = [...graph.nodes.values()].filter((n) => (n.s || '').length > (config.summaryMaxChars || 200));

    say(`${dry ? 'would remove' : 'removed'}: ${dead.length} dead nodes, ${orphans.length} orphan edges`);
    for (const n of dead.slice(0, 15)) say(`  ${n.id} ${n.k}`);
    if (oversized.length) {
      say(`\n${oversized.length} summaries exceed ${config.summaryMaxChars} chars — rewrite them denser:`);
      for (const n of oversized.slice(0, 10)) say(`  ${n.id} ${n.k} (${n.s.length})`);
    }
    if (dry) return;
    for (const n of dead) removeNode(graph, n.id);
    for (const key of orphans) graph.edges.delete(key);
    for (const [key, e] of graph.edges) {
      if (!graph.nodes.has(e[0]) || !graph.nodes.has(e[2])) graph.edges.delete(key);
    }
    saveGraph(ctx.dir, graph);
    buildIndex(ctx.dir, graph);
  },
};

COMMANDS.stats = {
  help: 'scope stats — store size in tokens, counts by type, and budget breaches',
  run(ctx) {
    const graph = requireStore(ctx);
    const config = loadConfig(ctx.dir);
    const layers = [
      ['MAP.md', path.join(ctx.root, '.scope', 'MAP.md')],
      ['nodes.jsonl', path.join(ctx.dir, 'graph', 'nodes.jsonl')],
      ['edges.jsonl', path.join(ctx.dir, 'graph', 'edges.jsonl')],
      ['terms.tsv', path.join(ctx.dir, 'index', 'terms.tsv')],
      ['overlays/git.json', path.join(ctx.dir, 'overlays', 'git.json')],
      ['overlays/issues.json', path.join(ctx.dir, 'overlays', 'issues.json')],
    ];
    let total = 0;
    say('layer                    bytes    ~tokens');
    for (const [name, file] of layers) {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (!name.startsWith('overlays')) total += estTokens(size);
      say(`${name.padEnd(22)} ${String(size).padStart(7)}  ${String(estTokens(size)).padStart(8)}`);
    }
    say(`${'committed total'.padEnd(22)} ${''.padStart(7)}  ${String(total).padStart(8)}`);

    const byType = {};
    for (const n of graph.nodes.values()) byType[n.t] = (byType[n.t] || 0) + 1;
    const byEdge = {};
    for (const e of graph.edges.values()) byEdge[e[1]] = (byEdge[e[1]] || 0) + 1;
    say(`\nnodes: ${Object.entries(byType).sort().map(([t, c]) => `${t} ${c}`).join(' · ')}`);
    say(`edges: ${Object.entries(byEdge).sort().map(([t, c]) => `${t} ${c}`).join(' · ')}`);

    const flow = flowGraph(graph);
    const deg = degrees(graph, flow);
    const top = [...graph.nodes.values()]
      .filter((n) => (deg.get(n.id) || {}).in)
      .sort((a, b) => deg.get(b.id).in - deg.get(a.id).in)
      .slice(0, 8);
    if (top.length) say(`\nmost depended on: ${top.map((n) => `${n.k} (${deg.get(n.id).in})`).join(', ')}`);
    // The enrichment pass (SKILL.md §0) is "summaries on the load-bearing files"; name the next
    // ones. Barrels are skipped — "re-exports everything" is not insight, and they top every list.
    const unsummarized = [...graph.nodes.values()]
      .filter((n) => ['file', 'entry'].includes(n.t) && n.by !== 'agent' && (deg.get(n.id) || {}).in)
      .filter((n) => !/(^|\/)index\.[a-z]+$/.test(n.k))
      .sort((a, b) => deg.get(b.id).in - deg.get(a.id).in || a.k.localeCompare(b.k));
    if (unsummarized.length) {
      say(`enrich next (${unsummarized.length} files with importers lack an agent summary): `
        + unsummarized.slice(0, 8).map((n) => `${n.k} (${deg.get(n.id).in})`).join(', '));
    }

    const stale = [...graph.nodes.values()].filter((n) => n.st === 'stale').length;
    const dead = [...graph.nodes.values()].filter((n) => n.st === 'dead').length;
    if (stale || dead) say(`\n${stale} stale, ${dead} dead — scope verify / scope prune`);
    if (total > config.budgets.store_tokens) say(`\nover budget: store is ${total} tokens vs ${config.budgets.store_tokens} — prune and tighten summaries`);
  },
};

COMMANDS.note = {
  help: 'scope note file add|set-summary|edge — write insight back into the graph',
  run(ctx, args) {
    const graph = requireStore(ctx);
    const config = loadConfig(ctx.dir);
    const max = config.summaryMaxChars || 200;
    const sub = args.positional[0];
    const now = Math.floor(Date.now() / 1000);

    if (sub === 'add') {
      const type = String(args.flags.type || 'note');
      if (!['concept', 'note'].includes(type)) fail('note add --type must be concept or note');
      const key = String(args.flags.key || fail('note add requires --key <slug>'));
      const summary = String(args.flags.summary || fail('note add requires --summary "..."'));
      if (summary.length > max) fail(`summary is ${summary.length} chars, limit is ${max} — say it denser`);
      const id = idFor(type, key, new Set(graph.nodes.keys()));
      const tags = args.flags.tags ? String(args.flags.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
      addNode(graph, { id, t: type, k: key, s: summary, g: tags, by: 'agent', ts: now });
      const edges = [].concat(args.flags.edge || []);
      for (const spec of Array.isArray(edges) ? edges : [edges]) {
        if (typeof spec !== 'string') continue;
        const [s, t, d] = spec.split('|').map((x) => x.trim());
        const src = s === 'this' ? { id } : resolveNode(graph, s);
        const dst = d === 'this' ? { id } : resolveNode(graph, d);
        addEdge(graph, src.id, t, dst.id);
      }
      say(`added ${id} ${type} ${key}`);
    } else if (sub === 'set-summary') {
      const node = resolveNode(graph, args.positional[1] || fail('usage: scope note file set-summary <id> --summary "..."'));
      const summary = String(args.flags.summary || fail('--summary is required'));
      if (summary.length > max) fail(`summary is ${summary.length} chars, limit is ${max} — say it denser`);
      node.s = summary;
      node.by = 'agent';
      node.ts = now;
      if (['file', 'entry', 'adr'].includes(node.t)) {
        const h = hashOfFile(ctx.root, node.k);
        if (h) node.h = h;
      }
      delete node.st;
      addNode(graph, node);
      say(`updated ${node.id} ${node.k}`);
    } else if (sub === 'edge') {
      const [s, t, d] = args.positional.slice(1);
      if (!s || !t || !d) fail('usage: scope note file edge <src> <type> <dst>');
      if (!EDGE_TYPES.has(t)) fail(`unknown edge type "${t}" — one of: ${[...EDGE_TYPES].join(', ')}`);
      const src = resolveNode(graph, s);
      const dst = resolveNode(graph, d);
      addEdge(graph, src.id, t, dst.id);
      say(`${src.id} -${t}→ ${dst.id}`);
    } else {
      fail('usage: scope note file add|set-summary|edge (see SKILL.md)');
    }

    saveGraph(ctx.dir, graph);
    buildIndex(ctx.dir, graph);
  },
};

function short(graph, id) {
  const n = graph.nodes.get(id);
  if (!n) return id;
  if (n.t === 'issue' || n.t === 'concept' || n.t === 'note' || n.t === 'skill') return n.k;
  // A barrel's basename says nothing; prefix the directory that names the package ("db/index.ts",
  // skipping src/lib wrappers) so three cross-package imports do not all read "index.ts".
  const parts = n.k.split('/');
  const base = parts.at(-1) || n.k;
  if (!/^(index|mod|__init__|main)\.[a-z]+$/.test(base)) return base;
  const owner = parts.slice(0, -1).reverse().find((d) => !/^(src|lib|app)$/.test(d));
  return owner ? `${owner}/${base}` : base;
}

// Placeholders wired into the dispatch table so `scan` can check self-knowledge drift
// against the real command list from the first commit onward.
COMMANDS.expand = {
  help: 'scope expand <path> — symbol-level nodes with line anchors for ranged reads',
  run(ctx, args) {
    const r = expand(ctx, args.raw);
    say(`${r.file.k}: ${r.total} symbols (${r.created} new, ${r.removed} gone)`);
    say('anchors now available — scope context ' + r.file.k);
  },
};

COMMANDS['git-overlay'] = {
  help: 'scope git-overlay — refresh per-file push state (pushed/unpushed/staged/modified/untracked)',
  run(ctx) {
    const o = gitOverlay(ctx);
    const head = o.detached ? 'detached HEAD' : `${o.branch || '(no branch)'}`;
    say(`${head} → ${o.upstream || 'no upstream'}${o.upstream ? ` (ahead ${o.ahead}, behind ${o.behind})` : ''}`);
    const parts = Object.entries(o.counts).filter(([, c]) => c > 0).map(([s, c]) => `${s} ${c}`);
    say(parts.length ? parts.join(' · ') : 'nothing tracked');
    for (const n of o.notes) say(`note: ${n}`);
  },
};

COMMANDS.issues = {
  help: 'scope issues [--limit N] | scope issues link --blocker N --blocked M — sync GitHub, or create a dependency',
  run(ctx, args) {
    const config = loadConfig(ctx.dir);
    if (args.positional[0] === 'link') {
      const blocker = Number(args.flags.blocker);
      const blocked = Number(args.flags.blocked);
      if (!blocker || !blocked) fail('usage: scope issues link --blocker <n> --blocked <m>');
      const r = linkIssues(ctx, blocker, blocked);
      say(`#${blocker} now blocks #${blocked}${r.already ? ' (already linked)' : ''} [db id ${r.dbid}]`);
      say('run `scope issues` to pull the new edge into the graph');
      return;
    }
    const graph = requireStore(ctx);
    const r = syncIssues(ctx, graph, {
      limit: args.flags.limit || config.github.issueLimit,
      linkCommits: config.github.linkCommits,
    });
    saveGraph(ctx.dir, graph);
    buildIndex(ctx.dir, graph);

    const issues = r.overlay.issues;
    const open = Object.values(issues).filter((i) => i.state === 'open').length;
    say(`${r.slug}: ${r.count} issues (${open} open), ${r.commitLinks} commit links`);
    if (r.fallbackMode) say('note: dependency API unavailable — relations read from issue bodies');
    if (r.overlay.frontier.length) {
      say(`frontier (open, unblocked, unassigned): ${r.overlay.frontier.map((n) => '#' + n).join(', ')}`);
      for (const n of r.overlay.frontier.slice(0, 5)) say(`  #${n} ${truncate(issues[String(n)].title, 70)}`);
    } else say('frontier: empty — every open issue is blocked or already assigned');
    const blocked = Object.entries(issues).filter(([, i]) => i.state === 'open' && i.openBlockedBy.length);
    for (const [n, i] of blocked) say(`  #${n} blocked by ${i.openBlockedBy.map((b) => '#' + b).join(', ')}`);
  },
};

COMMANDS['graph-html'] = {
  help: 'scope view — generate the self-contained interactive viewer for the user',
  run(ctx) {
    const graph = requireStore(ctx);
    const r = graphHtml(ctx, graph);
    say(`wrote ${r.file}`);
    say(`${r.nodes} nodes, ${r.edges} edges, ${Math.round(r.bytes / 1024)} KB, no external requests`);
    if (!r.hasGit) say('note: no git overlay — run `scope git-overlay` first to show push state');
    if (!r.hasIssues) say('note: no issue overlay — run `scope issues` first to show issues and blockers');
  },
};

// --- entry -----------------------------------------------------------------

function usage() {
  say('files engine — persistent codebase knowledge graph');
  say('');
  for (const name of Object.keys(COMMANDS).sort()) say('  ' + COMMANDS[name].help);
  say('');
  say('This engine backs the Scope skill; read its SKILL.md for the protocol.');
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { usage(); return 0; }
  const command = COMMANDS[cmd];
  if (!command) { say(`unknown command "${cmd}"`); usage(); return 2; }
  const args = parseArgs(argv.slice(1));
  args.raw = argv.slice(1);
  try {
    command.run(ctxFor(), args);
    return 0;
  } catch (e) {
    if (e instanceof ScopeError) { say(`error: ${e.message}`); return 1; }
    throw e;
  }
}

const code = main();
process.stdout.write(out.join('\n') + '\n');
process.exit(code);
