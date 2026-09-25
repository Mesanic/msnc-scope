# File graph store formats

The contract for everything under `.scope/files/`. Read this when editing the store by hand, debugging a
noisy diff, resolving a merge conflict, or extending the schema.

## Contents

- [Layout](#layout)
- [Node](#node)
- [Edge](#edge)
- [Id derivation](#id-derivation)
- [config.json](#configjson)
- [index/terms.tsv](#indextermstsv)
- [overlays/git.json](#overlaysgitjson)
- [overlays/issues.json](#overlaysissuesjson)
- [MAP.md](#mapmd)
- [Determinism and merges](#determinism-and-merges)

## Layout

| Path | Committed | Owner |
|---|---|---|
| `.scope/MAP.md` | yes | scan (auto sections) + agent (prose) |
| `.scope/files/config.json` | yes | human/agent |
| `.scope/files/graph/nodes.jsonl` | yes | scan + agent write-back |
| `.scope/files/graph/edges.jsonl` | yes | scan + issues + agent |
| `.scope/files/index/terms.tsv` | yes (regenerable) | index |
| `.scope/files/overlays/git.json` | **no** | git-overlay |
| `.scope/files/overlays/issues.json` | **no** | issues |
| `.scope/files/view/scope.html` | **no** | graph-html |

Overlays and the view are gitignored because they describe *this working tree right now*.
Committing them would produce a diff on every status change and conflict on every merge.

## Node

One JSON object per line in `graph/nodes.jsonl`. Keys are short because every node is read by a
machine and paid for in tokens.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable identifier. See [Id derivation](#id-derivation). |
| `t` | string | yes | Type: `file`, `mod`, `sym`, `concept`, `adr`, `issue`, `skill`, `note`, `entry` |
| `k` | string | yes | Canonical key. Paths are repo-relative POSIX. See table below. |
| `s` | string | yes | Summary, **hard max 200 chars** (`config.summaryMaxChars`) |
| `g` | string[] | no | Lowercase tags: module names, issue labels, `doc`, `test`, `scope` |
| `h` | string | no | 8 hex chars of sha256 over LF-normalized content, **as of when `s` was written** |
| `a` | array | no | Up to 8 anchors `["symbolName", lineNumber]`, 1-based |
| `st` | string | no | `stale` or `dead`. Omitted when `ok` (the common case) |
| `w` | int | no | Importance 1–5 from import fan-in quintile. Omitted when 1 |
| `by` | string | no | `agent` when a human-or-agent wrote `s`. Omitted when `scan` |
| `ts` | int | no | Epoch seconds of last agent write |

Key format by type:

| `t` | `k` | Example |
|---|---|---|
| `file`, `entry`, `adr` | repo-relative path | `src/auth/login.ts` |
| `mod` | directory path — only dirs that gather ≥2 files and hold a file of their own or ≥2 child modules; pass-through dirs attach to the nearest module above | `src/auth` |
| `sym` | `path#Symbol` | `src/auth/login.ts#loginUser` |
| `issue` | `#number` | `#42` |
| `concept`, `note` | kebab slug | `token-budget-policy` |
| `skill` | manifest key | `scope scan` |

**The `by` guard is load-bearing.** Scan never overwrites a summary where `by:agent` — it only
sets `st:stale` when the content hash drifts. Machine structure and human insight coexist; the
machine defers.

**`h` is frozen for agent summaries.** For scan-authored nodes `h` always tracks current content,
so they are never stale — the summary is regenerated with the file. For `by:agent` nodes `h` stays
pinned to the content the agent actually read, which is what makes `stale` mean something:
*this insight was written against a version of the file that no longer exists.* `note set-summary`
re-pins it. Staleness therefore only ever describes human or agent understanding going out of
date, which is the only kind that can.

**Why 200 chars.** Ten query hits at 200 chars is ~500 tokens. At 600 chars it is ~1500 and the
query stops being cheaper than reading a file, which defeats the point of the store.

## Edge

One JSON array per line in `graph/edges.jsonl`: `["srcId", "type", "dstId"]`, optionally a fourth
metadata object (rare, e.g. `{"n":3}` for mention count). Unique on the triple.

| Type | Direction | Owner | Meaning |
|---|---|---|---|
| `imports` | file → file | scan | Resolved static import/require/use |
| `exports` | file → sym | scan, expand | Public symbol of a file |
| `part-of` | file→mod, mod→mod, issue→issue | scan, issues | Containment / sub-issue |
| `tested-by` | file → file | scan | Matched by test naming convention |
| `documents` | doc\|adr → any | scan, agent | Doc mentions the target's path, or the target's comments cite the doc (`ADR-0003`, `spec/07`) |
| `calls` | sym → sym | expand, agent | Intra-file heuristic, or agent-observed |
| `blocks` | issue → issue | issues | Blocker → blocked (GitHub dependency) |
| `closes` | file → issue | issues | Commit touching this file said "closes #N" |
| `mentions` | issue → file, file → issue | issues | Path in issue body, or bare `#N` in a commit |
| `relates` | any → any | **agent only** | Coupling the scanner cannot see |
| `implements` | file\|sym → concept\|adr\|issue | **agent only** | This code realizes that idea |

**Ownership is what makes rescanning safe.** Scan rebuilds `imports`, `part-of`, `tested-by` and
`documents` — but only where the source id is a file, entry, adr or mod node. That prefix guard
matters: issues and skill nodes also use `part-of`, and those relations belong to issue sync and
the self-manifest. Without it, every scan would silently delete the issue hierarchy and the file graph's own
self-knowledge edges. `exports` and `calls` belong to `expand`, which rebuilds them per file.
Agent edges (`relates`, `implements`, agent-authored `calls`) are never machine-deleted; `prune`
removes them only when an endpoint node is gone.

**No regex-derived cross-file call graph.** Matching `foo(` across files produces mostly noise —
same-named methods, shadowed locals, string literals. Flow analysis therefore runs on `imports`
(plus any `calls` edges that expand or an agent contributed). This is a deliberate accuracy floor:
the file graph would rather say less and be right.

## Id derivation

- Most types: type prefix + first 6 hex of `sha256(t + ":" + k)` — e.g. `f3a91bc`, `m7d2e04`.
  Prefixes: `f` file, `m` mod, `y` sym, `c` concept, `d` adr, `e` entry, `n` note.
  On collision at allocation time, a 7th hex char is appended.
- `issue`: `i` + issue number (`i42`) — human-stable and greppable.
- `skill`: authored in `assets/self-manifest.json` (`k_scan`, `k_query`, …).

Hash-derived ids are stable across machines, clones and branches, with no counter file to
serialize on. Two branches that both index `src/new.ts` produce the *same* id, so the merge is a
duplicate line rather than a conflicting one.

## config.json

```json
{
  "v": 1,
  "name": "Map",
  "ignore": ["node_modules/**", "dist/**", "build/**", ".scope/**", "*.min.*", "*.lock",
             "package-lock.json", "*.map", ".git/**"],
  "maxFileKB": 512,
  "moduleDepth": 2,
  "summaryMaxChars": 200,
  "entrypoints": [],
  "externalDeps": false,
  "budgets": { "map_tokens": 600, "query_tokens": 1500, "context_tokens": 900, "store_tokens": 50000 },
  "github": { "enabled": true, "issueLimit": 200, "linkCommits": 200 }
}
```

`entrypoints` overrides auto-detection (`package.json` main/bin, `src/index.*`, `main.py`,
`cmd/*/main.go`, `src/main.rs`) and seeds column 0 of the flow view. `externalDeps: true` creates
nodes for third-party packages — off by default because it triples node count for little insight.
`moduleDepth` caps how deep directories become `mod` nodes.

## index/terms.tsv

`term<TAB>id,id,id` — one line per term. Terms sorted ascending, postings sorted ascending.

Tokenization (identical at index and query time): split `k` on `/ . _ - #` and at camelCase
boundaries, emitting both the parts and the joined lowercase form (`loginUser` → `login`, `user`,
`loginuser`); keep the basename whole as an extra term (`login.ts`); split anchor names the same
way; take summary words of ≥3 chars, lowercased and depunctuated, minus a ~30-word English
stoplist; tags verbatim. No stemming — it would make the index nondeterministic across
implementations for marginal recall.

Terms appearing in more than `max(20, 0.15 × N)` nodes are dropped as dynamic stopwords (except
tag-derived terms). Postings are capped at 64 ids, keeping the highest `w`.

Regenerable by `scope index`, which is also the merge-conflict escape hatch.

## overlays/git.json

```json
{ "v": 1, "generated": "2026-08-09T12:00:00Z",
  "branch": "master", "upstream": "origin/master", "ahead": 2, "behind": 0, "detached": false,
  "files": { "src/a.ts": "modified", "b.mjs": "untracked", "c.md": "unpushed" },
  "default": "pushed",
  "counts": { "pushed": 123, "unpushed": 1, "modified": 1, "untracked": 1 } }
```

States, worst-wins: `conflicted` > `modified` (unstaged change) > `staged` > `unpushed` (committed
but not on upstream) > `pushed`. Only non-`pushed` files are listed; `default` covers the rest,
which keeps the overlay small on clean trees. `upstream: null` means no tracking branch: push
state is unknowable, so only working-tree changes are marked, committed files render plain, and
`notes[0]` (shown as the viewer banner) carries the caveat. The overlay is rewritten by the
session hook and by every `scan`, not only by `git-overlay`.

## overlays/issues.json

```json
{ "v": 1, "generated": "...", "repo": "Mesanic/Map", "fallbackMode": false,
  "issues": { "42": { "state": "open", "title": "...", "labels": ["bug"], "assignees": [],
                      "dbid": 3131731234, "url": "https://github.com/...", "updatedAt": "...",
                      "blockedBy": [40, 41], "openBlockedBy": [40], "parent": 39, "subs": [43],
                      "frontier": false, "source": "api" } },
  "frontier": [40] }
```

`dbid` is cached so dependency writes need no extra fetch. `updatedAt` drives incremental resync.
`source` is `api` or `body-fallback`. Issue *knowledge* (title gist, labels as tags, relation
edges) lives in the committed graph; *volatile state* (open/closed, assignees, frontier) lives
only here, so opening and closing issues does not churn the committed store.

## MAP.md

Auto-generated sections are delimited by sentinels; everything outside them is preserved
byte-for-byte across scans:

```markdown
# Name — repo map
<!-- scope:auto:begin overview -->
...stack, counts, top modules with ids, entrypoints, stale count...
<!-- scope:auto:end overview -->

## Orientation
...agent-authored prose. Scan never touches this...

<!-- scope:auto:begin howto -->
...canonical query commands using real ids from this graph...
<!-- scope:auto:end howto -->
```

If a sentinel pair is missing, scan appends a fresh pair at the end rather than rewriting unmarked
text. The `## Orientation` section is where an agent explains what the project actually is — the
part no scanner can produce.

## Determinism and merges

**A scan with no file changes must produce a byte-identical store.** This is enforced in testing
and it is what keeps `git status` quiet. It requires: nodes sorted by `id`, edges sorted by
`(src, type, dst)`, object keys emitted in fixed order, terms and postings sorted, and content
hashed after CRLF→LF normalization so `core.autocrlf` cannot cause phantom drift.

Merge conflicts in JSONL are line-local because ids are content-derived and output is sorted.
Resolution is mechanical: **keep both sides, then run `scope scan && scope index`** — the scan
reconciles against the actual working tree and the index is regenerated from scratch. Never
hand-merge `terms.tsv`; delete it and re-index.
