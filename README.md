# Scope (archived snapshot)

> **Moved.** Scope is developed in [Mesanic/msnc](https://github.com/Mesanic/msnc) as the `msnc:scope` skill (`skills/scope`). This repo is an archived snapshot of that folder at MSNC commit `396c6f5` and is not updated.

**Know what breaks before you change it.** Scope maps a codebase twice, as a file graph (modules, imports, git state) and a symbol graph (functions, calls, line spans, tests), and `impact` runs both and reports where they disagree.

- `SKILL.md` is the skill as MSNC ships it.
- `scripts/scope.mjs` is the CLI: `node scripts/scope.mjs --help`.
- `engine/files` and `engine/symbols` are the two graph engines.

MIT license (`LICENSE`). The bundled tree-sitter runtime and grammars carry their own notices in `THIRD-PARTY-NOTICES.md`.
