# EDGE-CASES.md — the 21-item edge-case ledger

Each item states: what happens, why it is built that way, and how it surfaces to you
(labels, messages, exit codes). Verified against `scripts/lib/*.mjs` behavior; if code and
this list ever disagree, the code wins.

1. **BOM / CRLF normalization.** Every read strips a leading UTF-8 BOM and converts
   CRLF→LF before hashing, slicing or note-body normalization (`canonicalizeText`). Why:
   identical logic on Windows/Unix must produce byte-identical stores (design G3/G5).
   Surfacing: none — line numbers in slices/spans always refer to the normalized text;
   a CRLF file and its LF twin share node ids.

2. **Binary sniffing.** The first 8 192 bytes are checked for NUL; NUL ⇒ skipped as
   binary, never parsed. Data/doc extensions (.json/.md/.png/…) are denylisted from
   extraction entirely. Surfacing: `scan` stderr count `· N binary skipped`; denied
   extensions simply never appear in stats. Why: tree-sitter on binaries wastes seconds
   and yields garbage spans.

3. **Barrel depth-cap fallback.** Re-export chains (`index.ts` barrels) are followed up to
   5 hops (`BARREL_DEPTH_CAP`). Deeper: the binding falls back to the last barrel module
   and the call becomes a `heuristic` module-level edge. Surfacing: `heuristic` label on
   the call + `barrelOverflows=N` in `scope stats`. Why: unbounded re-export chasing is
   where naive mappers blow up; a capped honest guess beats an uncrawlable graph.

4. **Shadow-drop.** A call whose head is shadowed by a local variable or a parameter of
   the enclosing def produces NO edge (it would be wrong to point at the imported symbol).
   Same for wildcard/star-imported heads that resolve to no concrete symbol.
   Surfacing: only the aggregate `droppedCalls=N` stat — dropped calls are silent by
   design so the graph stays clean; treat absent edges as "unknown", not "none".

5. **Cycles.** Import cycles (a↔b) and recursive calls do not loop anything: impact BFS
   keeps a visited map keyed by node id with hop/confidence folding (strongest confidence,
   shortest hop wins); default traversal depth cap 32. Ledger rebinding and dangling
   checks iterate fixed record sets. Surfacing: nothing special — cycles just work; deep
   chains get cut by `--depth` with an explicit `+N more` hint.

6. **Decorator / annotation attachment.** TS/JSX decorators (`@Component(...)`) and Python
   decorators are captured onto the def record; Rust attributes likewise. Java/C# route
   annotations additionally *drive* route nodes. Surfacing: `decorators` array in the node
   JSONL record; route nodes named `"VERB path"` with per-family confidence (Spring/C#
   attributes exact, gin/rust-builder heuristic). Why: decorators carry framework meaning.
   Route honesty: an annotation naming SEVERAL paths (Java `{"/a","/b"}`) or SEVERAL
   HTTP verbs (Python `methods=["GET","POST"]`) yields NO route node — never a fabricated
   `ANY `/first-verb guess; single-path/single-verb forms extract as before.

7. **Monorepo resolution.** One project root = one store (NG4); module ids are path-derived
   per package (`packages/core/src/index` vs `packages/web/src/main`) so same-named files
   never collide. Test-runner markers are recognized at root and up to 3 directory levels
   below it. Go is the exception: a single `go.mod` at the scan root is read; nested Go
   modules are not. Surfacing: runner sources listed by `scope check --json`
   (`runnerSources`); imports crossing package boundaries inside one store still resolve
   if relative paths match.

8. **Minified & generated skips.** Files matching `*.min.*` are excluded from the walk
   outright; binaries via sniffing (item 2). Surfacing: they never appear in any output.
   Why: minified code produces one giant span of noise and wrecks budgets.

9. **Symlinks & special files.** The walker only descends directories and only reads
   regular files (`entry.isDirectory()/isFile()`); symlinks fail both tests on Windows and
   most Unix layouts, so linked trees are not followed twice (or at all). Surfacing: none
   — silently out of scope. Why: Windows-first (G5) and cycle-safe by construction.

10. **Empty corpus.** Scanning a directory with zero source files succeeds: meta.json is
    written with `complete: true`, zero nodes/edges. Queries then answer honestly:
    `locate` prints `no results for "…"`, `impact` prints `no dependents found`, `stats`
    shows zeros. Nothing treats "empty" as an error state.

11. **Schema bump: answering commands resync, read-only commands refuse.** A store whose
    `schemaVersion` is older than the tool's rebuilds itself transparently under the
    ANSWERING commands (locate / impact / slice / brief / note / check): their auto-resync
    scan force-fulls when meta is missing/older/corrupt. The read-only reporting commands
    never rewrite an index: `stats` and `view` REFUSE an older-schema store outright
    (exit 2, "run `scope scan` to rebuild"). A store NEWER than the tool is refused
    everywhere (we cannot parse our own future). Surfacing: answering command on an older
    store → silent full rescan (first run after upgrade is slower); `stats`/`view` on
    older, or any command on newer → `IndexVersionError`, exit 2.

12. **Concurrent writers.** Scan publishes segments+meta through tmp-file + atomic rename
    with bounded retries on Windows handle contention; ledger appends serialize through an
    exclusive `notes.lock` ('wx' create), retrying ~4 s, stealing locks older than 10 s
    (crashed-writer recovery). Surfacing: lock timeout → `LedgerLockError`, exit 1,
    "ledger is locked by another writer …; no changes were written". Readers never see
    half-written JSONL.

13. **Identical-body collisions.** Note keys are content-derived
    (`sha256(sigHash|normalizedBody)[:16]`); two live symbols with identical signature and
    body collide on one key. Surfacing: `scope check` reports `ambiguous` with BOTH
    candidate ids and refuses to pick (exit 1 until resolved). Why: silently choosing
    would attach knowledge to the wrong function; disambiguate by editing one body.

14. **Orphan notes.** When a noted symbol disappears and exactly one same-key candidate
    exists → automatic rebind (moves survive). Zero candidates → the note becomes an
    orphan: kept in the ledger, flagged each check. Surfacing: `orphans (N)` section,
    key + clipped text + last known location; exit 1 while orphans remain. Delete or
    rewrite the note once you have decided the knowledge is obsolete.

15. **Unknown-extension rough fallback.** Covered in LANGUAGES.md: unknown but
    source-plausible extensions get brace-block top-level symbols only — `kind:"symbol"`,
    `lang:"unknown"`, `confidence:"rough"`, no edges. Why: a wrong-but-labeled hint beats
    an invisible file, and pretending grammar-level precision without a grammar would be
    dishonest. Surfacing: `rough` labels everywhere those nodes appear;
    `lang unknown: … rough=N` line in `scope stats`.

16. **Large files.** Source files over 1 048 576 bytes (1 MiB,
    `MAX_SOURCE_FILE_BYTES`) are skipped BEFORE reading/parsing and never indexed.
    Minified-by-name (`*.min.*`) and binary files are skipped too (items 2/8). The gate
    runs before the incremental reuse fast path as well, so a pre-cap store cannot
    quietly keep serving an oversized file. Why: multi-megabyte sources are almost always
    generated/vendored data; parsing them wrecks scan latency for near-zero map value,
    and downstream budgets cannot rescue megabyte-wide spans. This replaces the earlier
    draft's "no cap" stance — the cap is the honesty-preserving choice. Surfacing: never
    silent — `scan` stderr gains `· N oversize skipped (cap 1048576 B)` plus one
    `note:` line per skipped path; `meta.stats.skippedOversize`; `scope stats` shows
    `skipped: binary=…, oversize=…`. Oversized files do NOT mark the index incomplete
    (deliberate skip, like binaries).

17. **Dangling references after deletions.** After edits, `check` diffs the pre-resync
    graph against the post-resync one; call/import edges aimed at vanished symbols are
    reported as `dangling` UNLESS the source demonstrably follows a same-named replacement
    ("healed" rename). Surfacing: `dangling (N)` section with source → removed-target
    lines; contributes to `issues`, exit 1 until fixed.

18. **Incomplete-index refusal.** If any file failed extraction during the resync that
    precedes every query, the symbols engine refuses to answer from a partial graph.
    Surfacing: `scope scan` prints per-file `warning:` lines and marks meta incomplete;
    query commands exit 2 with "index is incomplete (N files failed extraction);
    refusing to answer from an incomplete index". Corrupt segments similarly raise
    `StoreCorruptError` (exit 2) suggesting `scope scan --full`.

19. **Truncation honesty.** Every output has a deterministic budget contract:
    locate lines ellipsize at ~40 tokens; impact and check reports fill greedily under
    their caps (600 / 200 tokens) and end with explicit `+N more (...)` hints; briefs
    degrade preview-lines-first under 150 tokens; slices REFUSE over-budget asks instead
    of trimming; `--json` outputs are never truncated. Why: an agent that discovers cut
    content by accident plans on data it never saw — explicit truncation keeps the
    map trustworthy. You should never discover cut content by accident.

20. **Viewer data bounding.** `view` caps the self-contained HTML at 1 500 000 decimal
    bytes including embedded data. Overflow cuts deterministically: rank nodes by degree
    (desc), span size, id; nodes get ~62 % of the data budget, hub-first edges fill the
    rest, route/test partners are pulled in, leftover budget backfills nodes; lens lists
    cap per-section (drift/dangling 250, orphans 150, ambiguous 100, tests 120) and note
    counts cap at 64 KiB. Surfacing: stdout shows exact `shown of total` counts, a stderr
    warning notes truncation, and the HTML renders a truncation banner with the same
    numbers. See VIEWER.md for the algorithm.

21. **Per-project ignore list.** `IGNORE_DIRS` in `lib/walk.mjs` is the universal set
    (`node_modules`, `dist`, `vendor`, `target`, `__pycache__`, dotdirs). A repo that
    needs more creates `<root>/.scope/symbols/config.json` with
    `{ "ignoreDirs": ["runs", "apps/legacy"] }` — repo-relative posix paths matched
    against the directory itself, so a top-level name and a nested path both work. The
    walk is **pruned before descending**, so an ignored tree is never read. Why: this
    exists because one repo's `runs/` held 18 GB of experiment output that the walk
    traversed on every scan, and because binary dumps inside it were reported as
    oversize-skipped *source*, which reads as though real code had been dropped.
    Surfacing: none directly — the files simply do not appear in `stats` or the store.
    A missing or malformed config means no extra ignores and never fails a scan. The
    file is not gitignored (`scope init` ignores only `.scope/symbols/index/`), so it commits with
    the repo. The files engine keeps its own separate list at `.scope/files/config.json` under `ignore`
    (globs, not paths); both need the entry, and `scope view` reports the gap between
    them as skipped symbols.
