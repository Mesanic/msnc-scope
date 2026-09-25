# Third-party notices

Scope redistributes the prebuilt binaries below so that `scope scan` parses source
without a build step or a network fetch. They are unmodified upstream artifacts; only
`web-tree-sitter.js` was renamed to `.mjs` (byte-identical, see the note in
`engine/symbols/scripts/vendor/MANIFEST.json`, which also records a sha256 for each file).

Every one is under the MIT License. The full text appears once at the end; each package's
own copyright line is listed with it, as MIT requires.

| Package | Vendored as | Upstream | Copyright |
|---|---|---|---|
| `web-tree-sitter@0.26.13` | `engine/symbols/scripts/vendor/web-tree-sitter/` | https://github.com/tree-sitter/tree-sitter | Copyright (c) 2018 Max Brunsfeld |
| `tree-sitter-typescript@0.23.2` | `engine/symbols/scripts/vendor/grammars/tree-sitter-typescript.wasm, tree-sitter-tsx.wasm` | https://github.com/tree-sitter/tree-sitter-typescript | Copyright (c) 2017 Max Brunsfeld |
| `tree-sitter-python@0.25.0` | `engine/symbols/scripts/vendor/grammars/tree-sitter-python.wasm` | https://github.com/tree-sitter/tree-sitter-python | Copyright (c) 2016 Max Brunsfeld |
| `tree-sitter-go@0.25.0` | `engine/symbols/scripts/vendor/grammars/tree-sitter-go.wasm` | https://github.com/tree-sitter/tree-sitter-go | Copyright (c) 2014 Max Brunsfeld |
| `tree-sitter-rust@0.24.0` | `engine/symbols/scripts/vendor/grammars/tree-sitter-rust.wasm` | https://github.com/tree-sitter/tree-sitter-rust | Copyright (c) 2017 Maxim Sokolov |
| `tree-sitter-java@0.23.5` | `engine/symbols/scripts/vendor/grammars/tree-sitter-java.wasm` | https://github.com/tree-sitter/tree-sitter-java | Copyright (c) 2017 Ayman Nadeem |
| `tree-sitter-c-sharp@0.23.5` | `engine/symbols/scripts/vendor/grammars/tree-sitter-c_sharp.wasm` | https://github.com/tree-sitter/tree-sitter-c-sharp | Copyright (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors. |

## The MIT License (MIT)

Applies to every artifact in the table above, under its own copyright line:

- Copyright (c) 2018 Max Brunsfeld — *web-tree-sitter@0.26.13*
- Copyright (c) 2017 Max Brunsfeld — *tree-sitter-typescript@0.23.2*
- Copyright (c) 2016 Max Brunsfeld — *tree-sitter-python@0.25.0*
- Copyright (c) 2014 Max Brunsfeld — *tree-sitter-go@0.25.0*
- Copyright (c) 2017 Maxim Sokolov — *tree-sitter-rust@0.24.0*
- Copyright (c) 2017 Ayman Nadeem — *tree-sitter-java@0.23.5*
- Copyright (c) 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors. — *tree-sitter-c-sharp@0.23.5*

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
