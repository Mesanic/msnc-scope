# Scope ↔ GitHub

How issues, sub-issues and dependencies enter the graph, and the exact `gh` calls involved. Read
this before doing GitHub graph surgery by hand or debugging a sync that came back empty.

## Contents

- [What sync produces](#what-sync-produces)
- [The calls](#the-calls)
- [Dependencies: the database-id two-step](#dependencies-the-database-id-two-step)
- [Sub-issues](#sub-issues)
- [Fallback mode](#fallback-mode)
- [Linking issues to code](#linking-issues-to-code)
- [The frontier](#the-frontier)
- [Failure modes](#failure-modes)

## What sync produces

`scope issues` writes two things:

1. **Committed graph**: one `issue` node per issue (`i42`, summary = title truncated to 160 chars,
   labels as tags) plus `blocks`, `part-of`, `closes` and `mentions` edges.
2. **Volatile overlay** (`.scope/files/overlays/issues.json`, gitignored): open/closed state, assignees,
   cached database ids, blocker lists, and the computed frontier. Only the database ids are
   *cached* across syncs — see [`updatedAt` is not a freshness key for relations](#updatedat-is-not-a-freshness-key-for-relations).

The split matters. If open/closed lived in the committed graph, every issue closed anywhere would
dirty the repo and conflict across branches. Knowledge is durable; state is not.

Closed issues stay in the graph. A closed issue is a record of *why* code looks the way it does,
and `closes` edges make that discoverable from the file: `scope context src/auth/login.ts` shows
the issues that produced it.

## The calls

Repo is inferred from the git remote. All calls use argument arrays, never shell interpolation.

```bash
# preflight
gh auth status
gh repo view --json nameWithOwner --jq .nameWithOwner

# the bulk read — one call for everything cheap
gh issue list --state all --limit 200 \
   --json number,title,state,labels,assignees,body,url,updatedAt

# relations and database ids — one page-walk for the whole repo, 100 issues per call
gh api graphql -f query='{ repository(owner:"OWNER", name:"REPO") {
  issues(first:100) { pageInfo { hasNextPage endCursor } nodes {
    number databaseId
    blockedBy(first:100) { nodes { number state } }
    subIssues(first:100) { nodes { number } } } } } }'

# fallback only, when the GraphQL fields are unavailable: per issue
gh api repos/OWNER/REPO/issues/N --jq .id                        # database id
gh api repos/OWNER/REPO/issues/N/dependencies/blocked_by         # blockers
gh api repos/OWNER/REPO/issues/N/sub_issues                      # children
```

### `updatedAt` is not a freshness key for relations

**Creating a dependency does not touch the blocked issue's `updatedAt`.** Neither does adding a
sub-issue. So a cache keyed on `updatedAt` — which is what the sync uses for everything else —
will keep serving an issue's stale blocker list indefinitely, and the symptom is silent: the
**frontier reports a blocked issue as workable** and nothing looks wrong. It surfaces only when
someone compares the overlay against `gh api .../dependencies/blocked_by` by hand.

Relations are therefore re-read on every sync and never cached. That is affordable because the
GraphQL page-walk answers for a hundred issues per call; over the REST endpoints it would be
three subprocess calls per issue. The database id **is** cached, because it never changes.

If GraphQL is unavailable the sync falls back to the per-issue REST calls — still uncached for
relations, so still correct, just slower. Do not "optimise" that back into the `updatedAt` cache.

## Dependencies: the database-id two-step

This is the single easiest thing to get wrong. The dependencies endpoint takes the blocker's
numeric **database id** — not the `#number` you see in the UI, and not the GraphQL `node_id`.
Passing the issue number produces a confusing 404 or silently links the wrong issue.

```bash
# 1. resolve the BLOCKER's database id
BLOCKER_DBID=$(gh api repos/OWNER/REPO/issues/40 --jq .id)

# 2. tell the BLOCKED issue what blocks it
gh api --method POST repos/OWNER/REPO/issues/41/dependencies/blocked_by \
   -F issue_id="$BLOCKER_DBID"
```

`-F` sends a typed integer (`-f` would send a string and be rejected). A 422 "already exists" is
success — the link is present, which is all the caller wanted.

Use the wrapper rather than doing this by hand:

```bash
node "<scope>/scripts/scope.mjs" issues link --blocker 40 --blocked 41
```

To read dependencies back: `gh api repos/OWNER/REPO/issues/41/dependencies/blocked_by --jq '[.[] | {number, state}]'`.
Note the states — the file graph needs them to compute `openBlockedBy`, since a closed blocker no longer
blocks anything.

## Sub-issues

Same trick: the sub-issues endpoint also takes a **database id**, under a different field name.

```bash
SUB_DBID=$(gh api repos/OWNER/REPO/issues/43 --jq .id)
gh api --method POST repos/OWNER/REPO/issues/39/sub_issues -F sub_issue_id="$SUB_DBID"
```

This creates `["i43", "part-of", "i39"]`. Parent/child and blocking are different relations: a
parent is scope containment, a blocker is ordering. An epic's children are not blocked by the epic.

## Fallback mode

The dependencies and sub-issues endpoints are relatively new and can be unavailable (404/410) on
some repos or plans. On that response the file graph parses body conventions instead and sets
`fallbackMode: true` in the overlay:

```markdown
Blocked by: #40, #41
Part of #39
```

These are the same conventions `docs/agents/issue-tracker.md` prescribes when sub-issues are
disabled, so nothing has to change on the human side. The graph looks identical; only `source`
on each issue records how the relation was learned.

## Linking issues to code

Two mechanisms, both cheap:

- **Issue body → file.** Path-shaped tokens in the body (`src/auth/login.ts`) are matched against
  known node keys. Only real hits become `mentions` edges; unmatched strings are dropped rather
  than creating phantom nodes.
- **Commit history → file.** One `git log --name-only` pass over the last `config.github.linkCommits`
  commits. `closes #N` / `fixes #N` / `resolved #N` on a commit touching a file creates
  `["fileId", "closes", "iN"]`; a bare `#N` creates `mentions`.

The payoff: `scope context <file>` can answer "why does this file look like this" with the issues
that produced it, and the viewer can highlight where open work sits in the flow.

## The frontier

**Frontier = open, no *open* blockers, unassigned.** It is the set of issues that could actually
be started right now, and it is the right answer to "what should I pick up next" — better than the
full open list, which includes work that is blocked or already claimed.

Closing a blocker moves its dependents onto the frontier at the next sync. The viewer gives
frontier issues a glow halo; blocked-open issues get a lock glyph.

## Failure modes

| Symptom | Cause | Response |
|---|---|---|
| `gh: command not found` | CLI not installed / not on PATH | Scope exits 1 with that message; graph untouched |
| `gh auth status` nonzero | Not logged in | Run `gh auth login`; nothing is written |
| 404 on `/dependencies/blocked_by` | Endpoint unavailable for this repo | Automatic body-convention fallback |
| GraphQL `blockedBy`/`subIssues` undefined | Older GHES, or dependencies disabled | Falls back to the per-issue REST calls, then to body conventions |
| Frontier lists an issue you know is blocked | A relation cached against `updatedAt` | Fixed — relations are no longer cached; if it recurs, compare against `gh api .../dependencies/blocked_by` and treat it as a bug here |
| 422 on dependency POST | Link already exists | Treated as success |
| Empty issue list | Repo genuinely has none, or wrong remote | Check `gh repo view --json nameWithOwner` |
| Rate limited | Many issues, repeated full syncs | The GraphQL page-walk keeps a sync to a handful of calls; avoid `--full` loops |

On any API failure the previous overlay is left in place. A stale overlay is more useful than no
overlay, and the `generated` timestamp says how stale it is.
