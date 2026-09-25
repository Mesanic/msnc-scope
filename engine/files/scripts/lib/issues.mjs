// GitHub sync: issues become graph nodes, dependencies become edges, live state becomes an
// overlay. See ../references/GITHUB.md for the API details and the database-id nuance.
import path from 'node:path';
import {
  addEdge, addNode, filesDir, dropEdges, fail, ISSUE_EDGE_TYPES, readJsonIfExists, run,
  truncate, writeFileAtomic,
} from './store.mjs';

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
const REF = /(?:^|[^\w/])#(\d+)\b/g;
const BLOCKED_BY_LINE = /^\s*blocked\s*by:?\s*(.+)$/im;
const PART_OF_LINE = /^\s*part\s+of:?\s*#(\d+)/im;
const PATH_TOKEN = /(?:^|[\s`("'[])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6})/g;

function gh(args, cwd) {
  const r = run('gh', args, { cwd });
  if (r.missing) fail('gh CLI not found in PATH — install it or skip GitHub sync');
  return r;
}

function ghJson(args, cwd) {
  const r = gh(args, cwd);
  if (!r.ok) return { ok: false, err: r.err, out: null };
  try { return { ok: true, out: JSON.parse(r.out) }; } catch (e) { return { ok: false, err: e.message, out: null }; }
}

// `gh --jq` prints the raw jq result, so a string field arrives unquoted and is not valid JSON.
// Read it as text rather than parsing it.
export function repoSlug(root) {
  const r = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], root);
  if (!r.ok) return null;
  const slug = r.out.trim();
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
}

function parseNumbers(text) {
  const out = [];
  let m;
  const re = /#(\d+)/g;
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}

/**
 * Every issue's relations and database id, in one page-walk.
 *
 * This exists for correctness before speed. Creating a dependency does NOT touch the blocked
 * issue's `updatedAt` — so a cache keyed on `updatedAt`, which is what the rest of this sync
 * uses, keeps serving that issue's stale (usually empty) blocker list forever. The symptom is
 * the worst kind: the frontier reports a blocked issue as workable, and nothing looks wrong.
 * Relations therefore are not cached at all; they are re-read every sync.
 *
 * Doing that over the REST endpoints would cost three subprocess calls per issue. GraphQL
 * answers for a hundred issues at a time, so the honest version is also the fast one.
 *
 * Returns null when the query is unavailable (older GHES, dependencies disabled, no scope),
 * which puts the caller back on the per-issue REST path and then the body conventions.
 */
function fetchRelations(owner, repo, root) {
  const map = {};
  let cursor = null;

  for (let page = 0; page < 50; page += 1) {
    const after = cursor ? `, after: "${cursor}"` : '';
    const query = `{ repository(owner: "${owner}", name: "${repo}") { `
      + `issues(first: 100${after}) { pageInfo { hasNextPage endCursor } nodes { `
      + 'number databaseId '
      + 'blockedBy(first: 100) { nodes { number state } } '
      + 'subIssues(first: 100) { nodes { number } } } } } }';

    const r = ghJson(['api', 'graphql', '-f', `query=${query}`], root);
    const conn = r.ok && r.out && r.out.data && r.out.data.repository && r.out.data.repository.issues;
    if (!conn) return null;

    for (const n of conn.nodes || []) {
      const blockers = (n.blockedBy && n.blockedBy.nodes) || [];
      map[String(n.number)] = {
        dbid: typeof n.databaseId === 'number' ? n.databaseId : null,
        blockedBy: blockers.map((b) => b.number),
        // REST reports lower-case states and the frontier filter compares against 'open'.
        blockedByState: Object.fromEntries(blockers.map((b) => [b.number, String(b.state).toLowerCase()])),
        subs: ((n.subIssues && n.subIssues.nodes) || []).map((s) => s.number),
      };
    }

    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return map;
    cursor = conn.pageInfo.endCursor;
  }
  return map;
}

export function syncIssues(ctx, graph, opts = {}) {
  const { root } = ctx;
  const dir = filesDir(root);
  const auth = gh(['auth', 'status'], root);
  if (!auth.ok) fail('gh is not authenticated — run `gh auth login`, then retry');
  const slug = repoSlug(root);
  if (!slug) fail('could not determine the GitHub repo — check `git remote -v` and `gh repo view`');
  const [owner, repo] = slug.split('/');

  const prev = readJsonIfExists(path.join(dir, 'overlays', 'issues.json'));
  const cache = (prev && prev.repo === slug && prev.issues) || {};

  const limit = String(opts.limit || 200);
  const listed = ghJson(['issue', 'list', '--state', 'all', '--limit', limit,
    '--json', 'number,title,state,labels,assignees,body,url,updatedAt'], root);
  if (!listed.ok) fail(`gh issue list failed: ${listed.err || 'unknown error'}`);
  const issues = listed.out || [];

  let fallbackMode = false;
  const records = {};
  const relations = fetchRelations(owner, repo, root);

  for (const raw of issues) {
    const num = String(raw.number);
    const rel = relations && relations[num];
    const cached = cache[num];
    // `updatedAt` is a sound key for the database id — which never changes — and for nothing
    // else. Relations come from `relations` above, re-read every sync; see `fetchRelations`.
    const fresh = cached && cached.updatedAt === raw.updatedAt && cached.dbid;
    const rec = {
      state: raw.state.toLowerCase(),
      title: raw.title,
      labels: (raw.labels || []).map((l) => l.name),
      assignees: (raw.assignees || []).map((a) => a.login),
      url: raw.url,
      updatedAt: raw.updatedAt,
      dbid: fresh ? cached.dbid : null,
      blockedBy: [],
      parent: null,
      subs: [],
      source: 'api',
    };

    if (rel) {
      rec.dbid = rel.dbid ?? rec.dbid;
      rec.blockedBy = rel.blockedBy;
      rec.blockedByState = rel.blockedByState;
      rec.subs = rel.subs;
    } else {
      // No GraphQL: one call for the id (cacheable) and one per relation (not).
      if (!fresh) {
        const idRes = ghJson(['api', `repos/${owner}/${repo}/issues/${num}`, '--jq', '.id'], root);
        rec.dbid = idRes.ok ? idRes.out : null;
      }

      const blocked = ghJson(['api', `repos/${owner}/${repo}/issues/${num}/dependencies/blocked_by`,
        '--jq', '[.[] | {number, state}]'], root);
      if (blocked.ok && Array.isArray(blocked.out)) {
        rec.blockedBy = blocked.out.map((b) => b.number);
        rec.blockedByState = Object.fromEntries(blocked.out.map((b) => [b.number, b.state]));
      } else {
        // Endpoint unavailable on this repo/plan: fall back to the body conventions that
        // docs/agents/issue-tracker.md already prescribes when sub-issues are disabled.
        const m = (raw.body || '').match(BLOCKED_BY_LINE);
        rec.blockedBy = m ? parseNumbers(m[1]) : [];
        rec.blockedByState = {};
        rec.source = 'body-fallback';
        fallbackMode = true;
      }

      const subs = ghJson(['api', `repos/${owner}/${repo}/issues/${num}/sub_issues`, '--jq', '[.[].number]'], root);
      if (subs.ok && Array.isArray(subs.out)) rec.subs = subs.out;
      else {
        const pm = (raw.body || '').match(PART_OF_LINE);
        if (pm) rec.parent = Number(pm[1]);
        rec.source = rec.source === 'api' ? 'body-fallback' : rec.source;
        fallbackMode = true;
      }
    }

    rec.body = raw.body || '';
    records[num] = rec;
  }

  // parent links from the sub-issue lists we just gathered
  for (const [num, rec] of Object.entries(records)) {
    for (const sub of rec.subs || []) {
      if (records[String(sub)]) records[String(sub)].parent = Number(num);
    }
  }

  // Blocker state may be unknown in fallback mode; fill it from what we do know.
  for (const rec of Object.values(records)) {
    rec.openBlockedBy = (rec.blockedBy || []).filter((b) => {
      const known = records[String(b)];
      if (known) return known.state === 'open';
      const s = rec.blockedByState && rec.blockedByState[b];
      return s ? s === 'open' : true;
    });
    rec.frontier = rec.state === 'open' && !rec.openBlockedBy.length && !rec.assignees.length;
  }

  // --- graph write ---------------------------------------------------------
  dropEdges(graph, (e) => ISSUE_EDGE_TYPES.has(e[1]) || (e[1] === 'part-of' && e[0].startsWith('i')));
  const live = new Set(Object.keys(records).map((n) => 'i' + n));
  for (const n of [...graph.nodes.values()]) {
    if (n.t === 'issue' && !live.has(n.id)) { graph.nodes.delete(n.id); graph.byKey.delete('issue:' + n.k); }
  }

  const fileKeys = new Map();
  for (const n of graph.nodes.values()) {
    if (['file', 'entry', 'adr'].includes(n.t)) fileKeys.set(n.k, n.id);
  }

  for (const [num, rec] of Object.entries(records)) {
    const id = 'i' + num;
    const prevNode = graph.nodes.get(id);
    const node = {
      id, t: 'issue', k: '#' + num,
      s: prevNode && prevNode.by === 'agent' ? prevNode.s : truncate(rec.title, 160),
      g: ['issue', ...rec.labels.map((l) => l.toLowerCase())],
    };
    if (prevNode && prevNode.by === 'agent') { node.by = 'agent'; node.ts = prevNode.ts; }
    addNode(graph, node);

    for (const b of rec.blockedBy) if (records[String(b)]) addEdge(graph, 'i' + b, 'blocks', id);
    if (rec.parent && records[String(rec.parent)]) addEdge(graph, id, 'part-of', 'i' + rec.parent);

    PATH_TOKEN.lastIndex = 0;
    let m;
    const seen = new Set();
    while ((m = PATH_TOKEN.exec(rec.body)) !== null) {
      const key = m[1].replace(/^\.\//, '');
      if (seen.has(key) || !fileKeys.has(key)) continue;
      seen.add(key);
      addEdge(graph, id, 'mentions', fileKeys.get(key));
    }
  }

  // --- commits -> code/issue links ----------------------------------------
  const linkCommits = String(opts.linkCommits || 200);
  // NUL delimiters: they cannot appear in a commit message, so the record boundaries are
  // unambiguous. Each commit emits subject, body, then its file list.
  const log = run('git', ['log', '--name-only', '--format=%x00%s%x00%b%x00', '-n', linkCommits], { cwd: root });
  let commitLinks = 0;
  if (log.ok) {
    const parts = log.out.split('\0');
    for (let i = 1; i + 2 < parts.length + 1; i += 3) {
      const message = (parts[i] || '') + '\n' + (parts[i + 1] || '');
      const files = (parts[i + 2] || '').split('\n').map((f) => f.trim()).filter(Boolean);
      if (!files.length) continue;
      const closes = new Set();
      CLOSING.lastIndex = 0;
      let cm;
      while ((cm = CLOSING.exec(message)) !== null) closes.add(Number(cm[1]));
      const refs = new Set();
      REF.lastIndex = 0;
      let rm;
      while ((rm = REF.exec(message)) !== null) refs.add(Number(rm[1]));
      for (const f of files) {
        const fid = fileKeys.get(f);
        if (!fid) continue;
        for (const n of closes) if (records[String(n)]) { addEdge(graph, fid, 'closes', 'i' + n); commitLinks += 1; }
        for (const n of refs) if (!closes.has(n) && records[String(n)]) { addEdge(graph, fid, 'mentions', 'i' + n); commitLinks += 1; }
      }
    }
  }

  const overlay = {
    v: 1,
    generated: new Date().toISOString(),
    repo: slug,
    fallbackMode,
    issues: Object.fromEntries(Object.entries(records).map(([num, r]) => {
      const { body, ...rest } = r;
      return [num, rest];
    })),
    frontier: Object.entries(records).filter(([, r]) => r.frontier).map(([n]) => Number(n)).sort((a, b) => a - b),
  };
  writeFileAtomic(path.join(dir, 'overlays', 'issues.json'), JSON.stringify(overlay, null, 1) + '\n');

  return { slug, count: Object.keys(records).length, overlay, commitLinks, fallbackMode };
}

// Create a GitHub dependency. The endpoint takes the blocker's numeric DATABASE id, which is not
// the #number shown in the UI and not the GraphQL node_id - passing the wrong one 404s or links
// the wrong issue, so the resolution step is done here rather than left to the caller.
export function linkIssues(ctx, blocker, blocked) {
  const { root } = ctx;
  const slug = repoSlug(root);
  if (!slug) fail('could not determine the GitHub repo');
  const [owner, repo] = slug.split('/');

  const idRes = ghJson(['api', `repos/${owner}/${repo}/issues/${blocker}`, '--jq', '.id'], root);
  if (!idRes.ok || typeof idRes.out !== 'number') {
    fail(`could not resolve the database id of #${blocker}: ${idRes.err || 'unexpected response'}`);
  }
  const dbid = idRes.out;

  const post = gh(['api', '--method', 'POST',
    `repos/${owner}/${repo}/issues/${blocked}/dependencies/blocked_by`,
    '-F', `issue_id=${dbid}`], root);

  if (!post.ok) {
    const already = /already exists|has already/i.test(post.err || '') || /HTTP 422/.test(post.err || '');
    if (!already) fail(`could not link #${blocker} -> #${blocked}: ${(post.err || '').split('\n')[0]}`);
    return { slug, dbid, already: true };
  }
  return { slug, dbid, already: false };
}
