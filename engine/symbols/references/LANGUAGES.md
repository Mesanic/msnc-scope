# LANGUAGES.md — what the symbols engine captures per language

Every fact below is checked against the shipped extractors (`scripts/lib/extract-*.mjs`),
the grammar registry (`scripts/parsers/languages.mjs`) and the graph builder
(`scripts/lib/resolve.mjs`). If this file and the code disagree, the code wins — file a bug.

Registry order is fixed (python → tsx → typescript → go → rust → java → c-sharp) and
extension mapping is first-match-wins over that sorted registry, so file→language
resolution is deterministic.

## Confidence vocabulary (applies to every language)

- `exact` — produced by a real grammar parse AND a resolved binding (import path matched
  a tracked file without overflow).
- `heuristic` — a guess that survived shadow checks: same-file call fallback,
  `this.m()` dispatch, barrel re-export chains deeper than the cap, convention-based
  test pairing, Go interface satisfaction.
- `rough` — produced ONLY by the unknown-extension structural fallback (no grammar).

Every node and edge carries exactly one label, inline in all output. Weight your trust:
exact > heuristic > rough. When a claim matters (you are about to rename a public API),
re-read the cited lines before editing anything a `heuristic` edge pointed at.

## TypeScript / JavaScript — id `typescript`

- Extensions: `.ts .js .mjs .cjs .mts .cts` (the separate `tsx` registry entry owns
  `.tsx/.jsx`). JS/JSX are parsed by the TypeScript-family
  grammars (superset strategy keeps the vendor footprint small).
- Grammar: `tree-sitter-typescript.wasm`; queries `parsers/queries/typescript.scm`.
- Symbols captured: `function` (incl. generators, async, arrow-assigned), CommonJS
  export assignments `(module.)exports.NAME = function|arrow` (found by dogfooding
  express; JSDoc above the assignment attaches; `exports.X = <call-expression>` data
  exports are NOT defs), `method`, `class`, `interface`, `enum`, `type` alias, plus one
  `module` node per file.
- Imports: ESM `import`/`export … from`, plus CommonJS `require` in both shapes —
  plain (`var m = require('./m')`) and member-access (`var X = require('./m').member`,
  bound as a named import). Neither introduces a shadowing local.
- Captured relations: `call` (incl. `new` ctor calls), `import` (module→module),
  `contains`, heritage `extends`/`implements`, `route`.
- Signature text: `name(params)` plus `: RetType` when annotated; class/interface/type sigs
  are `Name<TypeParams>`. `sigHash` = sha256(sig)[:16].
- Exported flag: any enclosing `export`; decorators attached to the record
  (e.g. `@Component({...})`), JSDoc first paragraph becomes `summary`.
- Routes: Express/Koa-style registrations — receiver named `app|router|server|api`,
  method `get|post|put|patch|delete|options|head|all|use`, string literal path. Node kind
  `route`, name `"VERB path"`.
- Known limitations:
  - ESM-style TS specifiers ARE rewritten: `import ... from './user.js'` also tries
    `src/user.ts`/`.tsx`/`.mts`/`.cts` (NodeNext convention; literal `.js` file wins if
    one exists, so resolution is deterministic). Extensionless specifiers work as before.
  - No type system: overloads collapse to the parsed signature; generics erased.
  - Dynamic `require(variable)` and computed imports are not edges.

## TSX / JSX — id `tsx`

- Extensions: `.tsx .jsx`; grammar `tree-sitter-tsx.wasm`, same query file as TypeScript.
- Everything else identical to the `typescript` entry.

## Python — id `python`

- Extensions: `.py .pyi`; grammar `tree-sitter-python.wasm`, queries `queries/python.scm`.
- Symbols: `function`, `class`; functions defined inside a class body become `method`;
  module docstring becomes the module `summary`, def docstrings become symbol summaries;
  decorators are captured onto the record.
- Imports: absolute and relative (`level` counted from dots); `from pkg import name`
  resolves through package `__init__.py` chains; `from pkg import mod` binds the submodule
  as a namespace. Module ids use dotted paths (`pkg.core`), `__init__.py` maps to the
  directory (`<root>` for top-level).
- Routes: Flask/FastAPI-style decorators — `@app.route(...)`/`@app.get(...)` etc. on
  receivers `app|router|api|blueprint`; bare `@route(...)` defaults to GET unless
  `methods=["X"]` names one. A `methods=[...]` listing several verbs produces NO route
  (it is never collapsed to the first verb); a one-element list is honored as usual.
  Route-honesty rule (shared with Java): when no unique path or unique verb can be
  extracted, the symbols engine emits nothing instead of fabricating an endpoint.
- Tests: `test_*.py`/`*_test.py` pair to the same-named module by convention (`heuristic`)
  plus any imported target (`exact`).
- Limitations: no `__all__` awareness beyond plain re-export resolution; dynamic dispatch
  (strings naming functions) invisible.

## Go — id `go`

- Extension: `.go`; grammar `tree-sitter-go.wasm`, queries `queries/go.scm`.
- Symbols: top-level `func` → `function`; funcs with receivers → `method` (receiver type
  recorded); struct specs → `class`; interface specs → `interface` (with the method-name
  set kept for satisfaction checks).
- Exported flag = identifier starts uppercase (Go rule), not `export` syntax.
- Imports resolved through the module path in `<root>/go.mod` (read once per scan when any
  Go file exists): `modpath/internal/mathx` → that directory's non-test files as one
  package binding. Same-package identifiers resolve without imports.
- Interface satisfaction (deliberately `heuristic`): a concrete type `T` gets
  `T --implements--> I` when every method name of interface `I` appears in `T`'s method set
  and both files are in the same package or connected by an import. Method *signatures* are
  not compared — name-subset matching only.
- Routes: gin/chi-style registrations — receiver `r|router|routerGroup|engine|e|api|srv|mux|
  group|g|app`, method `GET|POST|...|Any`, always `heuristic`.
- Tests: `*_test.go` paired to same-directory, same-package non-test files (`heuristic`).
- Doc comments immediately above defs become `summary`.

## Rust — id `rust`

- Extension: `.rs`; grammar `tree-sitter-rust.wasm`, queries `queries/rust.scm`.
- Symbols: `fn` → `function`; fns inside `impl` → `method`; `struct` → `class`; `enum`;
  `union`/`type` → `type`; `trait` → `interface`. `pub` visibility drives `exported`.
  Attributes (`#[...]`) are captured like decorators; `//!`/`///` doc comments feed
  `summary`.
- Paths: `crate::…` resolves from `src/lib.rs` or `src/main.rs` (whichever exists);
  `self::`/`super::` relative to the current file; candidates tried as `dir.rs` then
  `dir/mod.rs`. `impl Trait for Type` produces `implements` heritage.
- Routes, two families:
  - actix/rocket attribute macros `#[get("/x")]`, `#[route("/x", method="POST")]` →
    confidence `exact`;
  - builder style `.route("/x", web::HttpMethod::Get)` / `.resource` / `.service` →
    confidence `heuristic`.
- Tests: integration tests under `tests/*.rs` point at the crate root (`heuristic`);
  unit-test modules inside source files are not separate files, so no pairing.

## Java — id `java`

- Extension: `.java`; grammar `tree-sitter-java.wasm`, queries `queries/java.scm`.
- Symbols: `class`, `interface`, `enum`, `record` (as `class`), methods and constructors
  as `method`.
- Imports: FQNs matched longest-first against a `package|ClassName` index built per scan;
  wildcard imports bind the whole package's top-level types; same-package types visible
  without imports (marked viaVisibility → bindings used for tests stay `heuristic`).
- Routes: Spring annotations — `@GetMapping`/`@PostMapping`/`@PutMapping`/
  `@PatchMapping`/`@DeleteMapping`/`@RequestMapping` at method level are `exact`
  (class-level `@RequestMapping` supplies the path prefix); combined annotation argument
  forms supported. A brace list naming several paths (`{"/a","/b"}`) produces NO route —
  the symbols engine never invents a single endpoint from a multi-path mapping (a single-literal
  brace form still extracts; an ambiguous class-level prefix degrades to no prefix).
  Route-honesty rule (shared with Python): no unique path or unique verb ⇒ no route node.
- Tests: files under `src/test/java/**` pair to the main class of the same package+stem
  (`FooTests.java`/`FooTest.java` → `Foo`) by convention (`heuristic`).

## C# — id `c-sharp`

- Extension: `.cs`; grammar `tree-sitter-c_sharp.wasm`, queries `queries/c-sharp.scm`.
- Symbols: `class`, `interface`, `struct`/`record` (as `class`), `enum`, methods.
- Imports: `using Namespace;` binds all top-level types of files declaring that namespace.
- Routes: ASP.NET attributes `HttpGet`/`HttpPost`/`HttpPut`/`HttpPatch`/`HttpDelete`/
  `Route` on actions — confidence `exact`; controller-level `Route("[controller]…")`
  prefixes apply.
- Tests: `*.Tests.cs` / `*.Test.cs` stems pair by convention (`heuristic`); a file whose
  content mentions a recognized test framework also counts as a test file.

## Unknown extensions — the `rough` fallback

Files whose extension is not in the registry, is not on the data denylist
(`.json .md .png …` — see `walk.mjs DATA_DENYLIST_EXTS`), is not empty, and is not
`*.min.*` get a structural pass: top-level brace blocks whose opening line looks like a
function/class-ish declaration become nodes with:

- `kind: "symbol"`, `lang: "unknown"`, `confidence: "rough"` everywhere,
- no imports/calls/routes — a rough file never contributes edges,
- module node also labeled `rough`.

Rough symbols appear in `locate`/`slice`/`brief` so nothing is invisible; treat their spans
as approximate. If a rough file matters to you, teach the symbols engine the extension instead of
trusting it blindly.

## Cross-cutting limits (all languages)

- Resolution is lexical + convention only (NG2 in the design doc). No compiler, no
  type inference, no cross-repo (one root = one store).
- `scope stats` reports plain `.js/.mjs/.cjs` files under the registry language id
  `typescript` (the superset grammar that parses them), not a separate `javascript`
  id — dogfooding on expressjs/express showed this reads oddly; it is labeling, not
  misparsing.
- Unresolved imports, dropped calls and barrel overflows are counted, never hidden:
  see `scope stats` → `unresolved:` line.
- Re-export barrels are followed up to depth 5 (`BARREL_DEPTH_CAP`); beyond that the
  binding falls back to the barrel module itself and the call is labeled `heuristic`.
