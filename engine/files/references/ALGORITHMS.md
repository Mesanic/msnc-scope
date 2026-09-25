# File graph algorithms

Retrieval ranking, language extraction and its limits, flow analysis. Read this when tuning search
or diagnosing a mis-parse.

## Contents

- [Tokenization](#tokenization)
- [Ranking](#ranking)
- [Language extraction](#language-extraction)
- [Import resolution](#import-resolution)
- [What the scanner will not do](#what-the-scanner-will-not-do)
- [Flow analysis](#flow-analysis)
- [Staleness](#staleness)

## Tokenization

Identical at index time and query time — any divergence silently breaks recall.

Keys split on `/ . _ - # :` and at camelCase boundaries, emitting both the parts and the joined
lowercase form, so `src/auth/loginUser.ts` yields `src`, `auth`, `loginuser`, `login`, `user`, `ts`
and the whole basename `loginuser.ts`. Anchor names split the same way. Tags are taken verbatim.
Summary words are lowercased, depunctuated, filtered to three characters or more, and passed
through a ~30-word stoplist.

No stemming. It would improve recall slightly and cost determinism — two implementations of a
stemmer disagree at the edges, and a store that reindexes differently on another machine is worse
than one that misses `logging` when you searched `logged`.

Terms appearing in more than `max(20, 15% of nodes)` are dropped as dynamic stopwords, except
tag-derived terms. Postings are capped at 64 ids, keeping the highest-importance nodes.

## Ranking

```
score = Σ over matched terms [ idf(t) × fieldWeight(t) ]
        × coverage × typeBoost × importance × stalePenalty

idf(t)       = ln(1 + N / df(t))
fieldWeight  = 3.0 key · 2.5 anchor · 2.0 tag · 1.0 summary   (best field wins per term)
coverage     = 0.5 + 0.5 × (matched terms / query terms)
typeBoost    = 1.3 entry · 1.2 module/concept/decision · 1.0 file/issue/skill · 0.9 symbol/note
importance   = 1 + 0.1 × (fan-in quintile − 1)
stalePenalty = 0.8 if stale, else 1
ties         → lower id first, so output is deterministic
```

The shape of this matters more than the constants. Field weights encode that a term in the path is
stronger evidence than the same term in prose. Coverage stops a node that matches one common term
from beating one that matches three. Type boosts push entrypoints and modules up because those are
better places to start reading. The stale penalty demotes rather than hides — a stale summary is
still the best orientation available, it just should not outrank a fresh one.

Retrieval is two-stage: the index yields candidates, then only those node lines are re-read and
scored. Scoring never touches the whole store.

## Language extraction

Comments are blanked (replaced with spaces, preserving byte offsets so line numbers stay valid)
before any pattern runs, using a small state machine that understands string literals, so a `//`
inside a URL is not mistaken for a comment and an `import` inside a docstring is not mistaken for
code.

| Language | Imports | Exported symbols |
|---|---|---|
| ts/js/tsx/jsx/mjs/cjs | `import … from '…'` (multi-line aware), `export … from '…'`, `require('…')`, dynamic `import('…')` | `export` declarations, `export { … }` with `as` aliases, `export default`, `module.exports` |
| py | `import a.b`, `from a.b import` (relative dots handled) | column-0 `def`/`class`, underscore-prefixed excluded |
| go | single imports and parenthesised import blocks | `func`, `type`; package from `package` |
| rs | `use a::b`, `mod x;` | `pub fn`, `pub struct/enum/trait` |
| java | `import a.b.C;` | `class`/`interface`/`enum`/`record`; methods via `expand` |
| cs | `using A.B;` | `class`/`interface`/`struct`/`enum`/`record` |
| md | — | headings become anchors; path mentions become `documents` edges |

**Doc citations.** Three token shapes are mentions: a full path (`src/auth/login.ts`), an ADR
number (`ADR-0003`, `ADR 3`), and a numbered-doc prefix (`spec/07`, `rfcs/0042`). The latter two
resolve only when exactly one markdown file matches (`docs/adr/0003-*.md`, `spec/07-*.md`). Markdown
is scanned whole; code is scanned **comments only**, because string literals hold routes and
fixtures rather than references. The edge always runs doc → code, whichever side held the
citation, so a file's card lists the decisions behind it under DOCS and a decision's card lists the
code that realises it under COVERS.

Anything else gets a tree-position summary and no edges — still findable by path and tag.

**Generated summaries.** The header's first *paragraph* (block or line comments, a Python
docstring, the first Markdown paragraph after headings and frontmatter) is the summary, truncated
to the budget minus room for `— N loc`. Structural bits — `loc`, `used by`, `imports`, then
`exports` — are appended only while they fit, exports last because anchors and the index already
carry the names. A file with no header gets only the structural line; the fix is a header, or
`scope note file set-summary`.

## Import resolution

Only imports that resolve to a file in this repo become edges. External packages are counted in
`stats` and otherwise ignored, because a node per npm package triples graph size for almost no
insight (`externalDeps: true` in config enables them if you disagree).

- **ts/js** — relative specifiers try the literal path, then each of eight extensions, then
  `/index.*`. Bare specifiers try two in-repo sources before being counted external: `tsconfig`
  `paths` (nearest config above the importer, `extends` followed, `baseUrl` relative to the
  declaring config) and workspace packages — every `package.json` with a `name`, mapped through
  `exports` (`.` and `./subpath`, first string among `source/import/default/types/require`), else
  `source/types/module/main`, else `src/index.ts`; a `dist/` target is retried under `src/`.
  `exports` glob patterns (`"./*"`) are not expanded — `src/<subpath>` is tried instead.
- **py** — dotted module to path, tried from the repo root, the importing file's directory, and
  `src/`; leading dots walk up from the importing file.
- **go** — `go.mod` gives the module prefix; internal imports resolve to the target *directory's*
  module node, since Go imports packages rather than files.
- **rs** — `mod x;` resolves to a sibling `x.rs` or `x/mod.rs`; `use` paths are tried longest-first
  under `src/`.
- **java/cs** — a package/namespace map built at scan start; resolved only when the match is
  unambiguous.

## What the scanner will not do

**Cross-file call graphs.** Matching `name(` across files produces mostly noise: same-named
methods on different classes, shadowed locals, strings, comments. The file graph would rather have a graph
you can trust than one that is complete and wrong. `expand` produces intra-file `calls` edges as a
heuristic sketch, and agents add real ones with `note edge` when they verify them.

**Dynamic dispatch, runtime wiring, DI containers, plugin registries, config-driven loading.** None
of these are statically visible. This is precisely the class of knowledge that write-back exists
for — an agent that traces one at runtime should record it as a `relates` edge, and then it is in
the graph permanently.

The honest framing: the scanner produces the skeleton, agents produce the understanding. A graph
that has been worked in for a month is substantially better than a freshly scanned one, and that
is by design.

## Flow analysis

**Roots** are declared entrypoints (well-known filenames, `package.json` main/bin, config globs)
plus any node nothing imports. Both are needed: the first is stable enough to be a node type, the
second catches real roots the conventions miss.

**Depth** is BFS distance from the nearest root along `imports`.

**Upstream** of a node is its importers, transitively — what breaks if it changes. **Downstream**
is what it imports — what it relies on. The output always labels these in words rather than
relying on the reader sharing a convention.

**The explanatory chain** shown by `scope context` is a bounded DFS on the reverse graph that
prefers paths rooted at a declared entrypoint over longer paths that are not. A test file importing
a module is technically an upstream root, but "reached from `src/index.ts`" explains how the
program works and "reached from `login.test.ts`" does not.

**Layering** (viewer) removes cycles with an iterative DFS, records back edges for display, then
assigns `layer(v) = max(layer(predecessors)) + 1` over the remaining DAG, followed by four
barycenter sweeps to reduce edge crossings.

## Staleness

A node is stale when the file's current content hash differs from `h`, the hash captured when its
summary was written. Scan-authored summaries are regenerated with the file, so they are never
stale — only agent-written insight can go out of date, which is exactly what the flag is for.

`scope verify` recomputes hashes and reports drift. `scope note file set-summary` re-pins `h` and clears
the flag. `scope prune` removes nodes whose file is gone. The intended rhythm is verify after a
refactor, re-bless what you can vouch for, and prune when files disappear.
