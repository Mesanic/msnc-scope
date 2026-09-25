---
name: scope
description: Code map of the repo. Use when the repo has `.scope/`, to find code before grepping and to run impact before editing a mapped file.
---

# Scope

A code map with two graphs: a **file graph** (modules, imports, git state) and a **symbol graph** (functions, calls, line spans, tests). They fail in opposite directions: symbol analysis misses a call made through a variable, the file graph sees the import but not the line. `impact` runs both and hands you the difference.

Run every command from the repo root as `node "${CLAUDE_SKILL_DIR}/scripts/scope.mjs" <command>`, with the full path typed out each time, as below. Type the full command; don't set a shell variable for the path, so the impact call shows as `scope.mjs impact`. `--help` lists every command; `status` first when anything looks wrong.

## `/msnc:scope init`

Arguments: `$ARGUMENTS`. When they are `init`, or the repo has no `.scope/` yet, run `node "${CLAUDE_SKILL_DIR}/scripts/scope.mjs" scan` and report its summary lines. That is all init does: it builds `.scope/` (`files/`, `symbols/` and `MAP.md`) and appends its entries to `.gitignore`. This copy writes no hooks and no `CLAUDE.md` block; MSNC's own hook is the edit gate. Run it again to rescan: after a commit, or after multi-file edits.

## The core loop

```bash
node "${CLAUDE_SKILL_DIR}/scripts/scope.mjs" map                           # 1. the repo's orientation card
node "${CLAUDE_SKILL_DIR}/scripts/scope.mjs" query "auth session"          #    ranked hits for the task's nouns, before a repo-wide grep
node "${CLAUDE_SKILL_DIR}/scripts/scope.mjs" context src/router.ts         #    one card: importers, imports, tests, docs, git
node "${CLAUDE_SKILL_DIR}/scripts/scope.mjs" locate createUser             # 2. exact id, file and span
node "${CLAUDE_SKILL_DIR}/scripts/scope.mjs" impact createUser             # 3. dependents + cross-check, before EVERY edit to a mapped file
node "${CLAUDE_SKILL_DIR}/scripts/scope.mjs" slice fn:89aa5d44a113         # 4. read only what you will touch
                                                                           # 5. edit
node "${CLAUDE_SKILL_DIR}/scripts/scope.mjs" check                         # 6. exits 1 if anything dangles; fix until 0
node "${CLAUDE_SKILL_DIR}/scripts/scope.mjs" scan                          # 7. rescan both graphs after multi-file edits
```

## Impact

- A symbol name or id → dependents with line spans and covering tests. A file path → every importer, transitively (`--depth <n>`).
- CSS, HTML and other files with no symbols are answered from the file graph alone (`file graph only`). References by name (`<link>`, class names) are not import edges: grep for those.
- Read the **cross-check** list every time. Each entry is either (a) a dynamic call symbol analysis cannot resolve, a real dependent, or (b) an import of some other name from that file. `grep -n "<name>" <file>` decides: the name is called → add the file to your edit list; absent → ignore it. At the file altitude every entry is a real dependent.
- Ambiguous names are refused with every candidate id: pick one, never guess.

## The gate

MSNC's hook refuses an edit (Edit, Write, MultiEdit, NotebookEdit, and Bash `sed -i`, `tee`, `cp`, `mv`, `rm` and similar) to a file in the map until `impact` has run on it in the last 2 hours. The refusal prints the exact command; run it, resolve the cross-check, then repeat the edit. If you can't run it, or it ran and the gate still refuses, stop and quote the refusal's command exactly as printed, absolute path and file included, in your reply, so the user can run it. New files and files outside the map are never gated. `>` redirects are not caught. The `scope_gate` option turns the gate off.

Nothing here runs tests or builds: `impact` names the covering tests, you run them.
