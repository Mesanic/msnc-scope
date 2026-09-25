import path from 'node:path';
import { makeNodeId, nodeSigHash } from './store.mjs';
import { cmpStr } from './util.mjs';

export const BARREL_DEPTH_CAP = 5;

export const NODE_PREFIX = Object.freeze({
  function: 'fn',
  method: 'method',
  class: 'cls',
  interface: 'iface',
  type: 'type',
  enum: 'enum',
  module: 'mod',
  route: 'route',
  impl: 'imp',
  symbol: 'sym',
});

export const TEST_FILE_PATTERNS = Object.freeze([
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(test_[^/]*|[^/]*_test)\.pyi?$/,
  /_test\.go$/,
  /(^|\/)tests\/[^/]+\.rs$/,
  /(^|\/)src\/test\/java\/.+\.java$/,
  /\.tests?\.cs$/,
]);

const TS_RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function isTestFile(posixPath) {
  return TEST_FILE_PATTERNS.some((re) => re.test(posixPath));
}

export function moduleIdForFile(posixPath, lang) {
  if (lang === 'python') {
    const base = path.posix.basename(posixPath, path.posix.extname(posixPath));
    const dir = path.posix.dirname(posixPath);
    if (base === '__init__') return dir === '.' ? '<root>' : dir;
    return dir === '.' ? base : path.posix.join(dir, base);
  }
  const ext = path.posix.extname(posixPath);
  return posixPath.slice(0, posixPath.length - ext.length);
}

export function conventionTestTarget(posixPath, lang) {
  const ext = path.posix.extname(posixPath);
  const withoutExt = posixPath.slice(0, posixPath.length - ext.length);
  let base = withoutExt.replace(/(\.test|\.spec)$/, '');
  const dir = path.posix.dirname(base);
  let name = path.posix.basename(base);
  if (lang === 'python') {
    if (name.startsWith('test_')) name = name.slice(5);
    else if (name.endsWith('_test')) name = name.slice(0, -5);
    else return null;
    return dir === '.' ? name : path.posix.join(dir, name);
  }
  if (lang === 'java') {
    const m = /^(.*src\/test\/java\/)(.+)$/.exec(base);
    if (!m) return null;
    const innerDir = path.posix.dirname(m[2]);
    const stem = path.posix.basename(m[2]).replace(/Tests?$/, '');
    if (!stem || stem === path.posix.basename(m[2])) return null;
    const target = `${m[1]}${innerDir === '.' ? '' : `${innerDir}/`}${stem}`;
    return moduleIdForFile(`${target}.java`, lang);
  }
  if (lang === 'c-sharp') {
    const stem = name.replace(/Tests?$/, '');
    if (!stem || stem === name) return null;
    return moduleIdForFile(path.posix.join(dir, stem), lang);
  }
  return dir === '.' ? name : path.posix.join(dir, name);
}

function makeNode(kindPrefix, kind, lang, posixPath, name, span, sigHash, extra) {
  return {
    _: 'node',
    id: makeNodeId(kindPrefix, posixPath, name, span, sigHash),
    kind,
    lang,
    path: posixPath,
    name,
    span: { sl: span.sl, sb: span.sb, el: span.el, eb: span.eb },
    sigHash,
    confidence: 'exact',
    sig: '',
    exported: true,
    decorators: [],
    summary: null,
    ...extra,
  };
}

function makeEdge(src, dst, type, confidence, f, label = null) {
  return { _: 'edge', src, dst, type, label, confidence, f };
}

export function buildGraph(files, options = {}) {
  const goModulePath = typeof options.goModulePath === 'string' ? options.goModulePath : null;
  const sorted = [...files].sort((a, b) => cmpStr(a.path, b.path));
  const known = new Set(sorted.map((f) => f.path));

  const nodes = [];
  const stats = { unresolvedImports: 0, droppedCalls: 0, barrelOverflows: 0 };

  const byPath = new Map();
  const defIdByKey = new Map();
  const defsByNameByPath = new Map();

  for (const file of sorted) {
    byPath.set(file.path, file);
    const moduleId = moduleIdForFile(file.path, file.lang);
    const span = { sl: 1, sb: 0, el: Math.max(1, file.facts.lineCount), eb: file.bytes };
    const sigHash = nodeSigHash('');
    const modNode = makeNode(NODE_PREFIX.module, 'module', file.lang, file.path, moduleId, span, sigHash, {
      summary: file.facts.moduleSummary ?? null,
      ...(file.lang === 'unknown' ? { confidence: 'rough' } : {}),
    });
    file._moduleNode = modNode;
    nodes.push(modNode);

    const namesMap = new Map();
    for (const def of file.facts.defs) {
      const prefix = NODE_PREFIX[def.kind];
      if (!prefix) continue;
      const spanD = { sl: def.sl, sb: def.sb, el: def.el, eb: def.eb };
      const id = makeNodeId(prefix, file.path, def.name, spanD, def.sigHash);
      defIdByKey.set(`${file.path}|${def.key}`, id);
      if (!namesMap.has(def.name)) namesMap.set(def.name, []);
      namesMap.get(def.name).push({ key: def.key, id });
      nodes.push(
        makeNode(prefix, def.kind, file.lang, file.path, def.name, spanD, def.sigHash, {
          sig: def.sig,
          exported: Boolean(def.exported),
          decorators: [...def.decorators],
          summary: def.summary ?? null,
          ...(file.lang === 'unknown' ? { confidence: 'rough' } : {}),
        }),
      );
    }
    defsByNameByPath.set(file.path, namesMap);
  }

  function definedNamesIn(filePosix, name) {
    const list = defsByNameByPath.get(filePosix)?.get(name);
    return list ?? [];
  }

  function reexportsOf(filePosix) {
    return byPath.get(filePosix)?.facts.reexports ?? [];
  }

  function resolveSpecFile(specObj, fromPosix, lang) {
    const cands = [];
    if (lang === 'python') {
      // Absolute imports (level 0) resolve from the sys.path roots — the project
      // root, plus src/ for the src-layout convention — NOT from the importing
      // file's own directory. Resolving them against the file's directory is
      // Python-2 implicit-relative semantics, removed in Py3, and it silently
      // drops every absolute import made from a subdirectory.
      // Explicit relative imports (level >= 1) walk up from the file as before.
      let bases;
      if (specObj.level === 0) {
        bases = ['.', 'src'];
      } else {
        let base = path.posix.dirname(fromPosix);
        for (let i = 1; i < specObj.level; i++) base = path.posix.dirname(base);
        bases = [base];
      }
      const dotted = specObj.tail ? specObj.tail.split('.') : [];
      for (const base of bases) {
        if (dotted.length > 0) {
          const parts = [base, ...dotted].filter((s) => s && s !== '.');
          const joined = path.posix.join(...parts);
          cands.push(joined + '.py', joined + '.pyi', path.posix.join(joined, '__init__.py'));
        } else {
          cands.push(path.posix.join(base, '__init__.py'));
        }
      }
    } else {
      if (!(specObj.startsWith('./') || specObj.startsWith('../'))) return null;
      // Literal spec first, then the TypeScript NodeNext rewrite: an ESM-style
      // specifier ending .js/.jsx/.mjs/.cjs may name a .ts/.tsx/.mts/.cts file.
      // Deterministic order — a real .js file always wins over its .ts twin.
      const specBases = [specObj];
      const rewritten = String(specObj).replace(/\.[cm]?jsx?$/, '');
      if (rewritten !== specObj && rewritten.length > 0) specBases.push(rewritten);
      for (const base0 of specBases) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPosix), base0));
        cands.push(base);
        for (const ext of TS_RESOLVE_EXTS) cands.push(base + ext);
        for (const ext of TS_RESOLVE_EXTS) cands.push(path.posix.join(base, 'index' + ext));
      }
    }
    for (const cand of cands) {
      if (known.has(cand)) return cand;
    }
    return null;
  }

  function pythonSubmoduleOf(moduleFilePosix, name) {
    const dir = path.posix.dirname(moduleFilePosix);
    const cands = [path.posix.join(dir, name + '.py'), path.posix.join(dir, name, '__init__.py')];
    for (const cand of cands) {
      if (known.has(cand)) return cand;
    }
    return null;
  }

  const goPackageDirs = new Map();
  for (const file of sorted) {
    if (file.lang !== 'go') continue;
    const dir = path.posix.dirname(file.path);
    if (!goPackageDirs.has(dir)) goPackageDirs.set(dir, []);
    goPackageDirs.get(dir).push(file);
  }
  for (const list of goPackageDirs.values()) list.sort((a, b) => cmpStr(a.path, b.path));

  const rustCrateRoot = ['src/lib.rs', 'src/main.rs'].find((p) => known.has(p)) ?? null;

  const javaClassIndex = new Map();
  const javaPackageFiles = new Map();
  for (const file of sorted) {
    if (file.lang !== 'java') continue;
    const pkg = file.facts.packageName ?? '';
    if (!javaPackageFiles.has(pkg)) javaPackageFiles.set(pkg, []);
    javaPackageFiles.get(pkg).push(file);
    for (const def of file.facts.defs) {
      if (def.ownerKey) continue;
      const key = `${pkg}|${def.name}`;
      if (!javaClassIndex.has(key)) javaClassIndex.set(key, file.path);
    }
  }

  const csharpNamespaceFiles = new Map();
  for (const file of sorted) {
    if (file.lang !== 'c-sharp' || !file.facts.namespace) continue;
    const ns = file.facts.namespace;
    if (!csharpNamespaceFiles.has(ns)) csharpNamespaceFiles.set(ns, []);
    csharpNamespaceFiles.get(ns).push(file);
  }
  for (const list of csharpNamespaceFiles.values()) list.sort((a, b) => cmpStr(a.path, b.path));

  function resolveGoImport(spec) {
    let rest = spec;
    if (goModulePath && spec.startsWith(`${goModulePath}/`)) rest = spec.slice(goModulePath.length + 1);
    else if (goModulePath && spec === goModulePath) rest = '.';
    else return null;
    const dir = rest === '.' ? '.' : rest.replace(/\/+$/, '');
    const pkgFiles = goPackageDirs.get(dir);
    if (!pkgFiles || pkgFiles.length === 0) return null;
    return pkgFiles.filter((f) => !isTestFile(f.path));
  }

  function resolveRustSpec(segments, fromPosix, preferItem = false) {
    let baseDir = null;
    let rest = segments;
    if (segments[0] === 'crate') {
      if (!rustCrateRoot) return null;
      baseDir = 'src';
      rest = segments.slice(1);
    } else if (segments[0] === 'self') {
      baseDir = path.posix.dirname(fromPosix);
      rest = segments.slice(1);
    } else if (segments[0] === 'super') {
      let supers = 0;
      while (rest[supers] === 'super') supers += 1;
      baseDir = path.posix.dirname(fromPosix);
      for (let i = 0; i < supers; i++) baseDir = path.posix.dirname(baseDir);
      rest = rest.slice(supers);
    } else {
      return null;
    }
    while (baseDir === '.' || baseDir === '/') baseDir = '';
    const maxTake = preferItem && rest.length > 0 ? rest.length - 1 : rest.length;
    for (let take = maxTake; take >= Math.max(0, rest.length - 1); take--) {
      const modSegs = rest.slice(0, take);
      let dir = baseDir;
      for (const seg of modSegs) dir = dir ? `${dir}/${seg}` : seg;
      const cands =
        take > 0
          ? [`${dir}.rs`, `${dir}/mod.rs`]
          : [rustCrateRoot, baseDir ? `${baseDir}/mod.rs` : 'mod.rs'];
      for (const cand of cands) {
        if (cand && known.has(cand)) return { file: cand, item: take < rest.length ? rest[take] : null };
      }
    }
    return null;
  }

  function resolveJavaSpec(imp) {
    if (imp.wildcard) return null;
    const parts = String(imp.spec ?? '').split('.').filter(Boolean);
    if (parts.length === 0) return null;
    if (imp.static && parts.length >= 2) {
      const memberName = parts[parts.length - 1];
      const hit = longestJavaClass(parts.slice(0, -1));
      if (hit) return { file: hit.file, classSymbol: hit.className, staticMember: memberName };
    }
    const direct = longestJavaClass(parts);
    if (direct) return { file: direct.file, classSymbol: direct.className };
    return null;
  }

  function longestJavaClass(parts) {
    for (let cut = parts.length; cut >= 1; cut--) {
      const key = `${parts.slice(0, cut - 1).join('.')}|${parts[cut - 1]}`;
      const fileHit = javaClassIndex.get(key);
      if (fileHit) return { file: fileHit, className: parts[cut - 1] };
    }
    return null;
  }

  function tryJavaClass(pkgParts, className) {
    const key = `${pkgParts.join('.')}|${className}`;
    if (javaClassIndex.has(key)) return javaClassIndex.get(key);
    return null;
  }

  function resolveSymbolIn(filePosix, name, depth) {
    if (depth > BARREL_DEPTH_CAP) return { overflow: true, lastHop: filePosix };
    const direct = definedNamesIn(filePosix, name);
    if (direct.length > 0) return { file: filePosix, id: direct[0].id, depth, overflow: false };
    const lang = byPath.get(filePosix)?.lang;
    if (lang === 'python') {
      const sub = pythonSubmoduleOf(filePosix, name);
      if (sub) return { file: sub, moduleOnly: true, depth, overflow: false };
    }
    for (const r of reexportsOf(filePosix)) {
      const targetSpec = resolveSpecFile(r.spec, filePosix, lang ?? 'typescript');
      if (!targetSpec) continue;
      let found = null;
      if (r.wildcard) {
        found = resolveSymbolIn(targetSpec, name, depth + 1);
      } else {
        for (const entry of r.entries) {
          if (entry.exported !== name) continue;
          found = resolveSymbolIn(targetSpec, entry.origin, depth + 1);
          break;
        }
      }
      if (found) return found;
    }
    for (const rec of rawImportsByPath.get(filePosix) ?? []) {
      if (!rec.targetFile || !rec.imp || rec.imp.ns) continue;
      const fromLang = byPath.get(filePosix)?.lang;
      if (fromLang !== 'python') continue;
      let found = null;
      if (rec.imp.wildcard) {
        found = resolveSymbolIn(rec.targetFile, name, depth + 1);
      } else {
        for (const n of rec.imp.names ?? []) {
          if ((n.alias ?? n.name) !== name) continue;
          found = resolveSymbolIn(rec.targetFile, n.name, depth + 1);
          break;
        }
      }
      if (found) return found;
    }
    return null;
  }

  const edgeIndex = new Map();
  const edgeKey = (e) => `${e.src}|${e.dst}|${e.type}|${e.label ?? ''}`;

  function commitEdge(edge) {
    if (!edge.src || !edge.dst) return false;
    const key = edgeKey(edge);
    const prev = edgeIndex.get(key);
    if (!prev) {
      edgeIndex.set(key, edge);
      return true;
    }
    if (prev.confidence !== 'exact' && edge.confidence === 'exact') prev.confidence = 'exact';
    return true;
  }

  for (const file of sorted) {
    for (const def of file.facts.defs) {
      const selfId = defIdByKey.get(`${file.path}|${def.key}`);
      const ownerId = def.ownerKey
        ? defIdByKey.get(`${file.path}|${def.ownerKey}`)
        : file._moduleNode.id;
      if (selfId && ownerId) commitEdge(makeEdge(ownerId, selfId, 'contains', 'exact', file.path));
    }
  }

  const rawImportsByPath = new Map();
  for (const file of sorted) {
    const recs = [];
    for (const imp of file.facts.imports) {
      const specObj =
        file.lang === 'python'
          ? { level: imp.level ?? 0, tail: imp.spec ?? '' }
          : imp.spec;
      recs.push({ imp, targetFile: resolveSpecFile(specObj, file.path, file.lang) });
    }
    rawImportsByPath.set(file.path, recs);
  }

  const importTables = new Map();

  for (const file of sorted) {
    const table = new Map();
    for (const { imp, targetFile } of rawImportsByPath.get(file.path) ?? []) {
      if (!targetFile) {
        stats.unresolvedImports += 1;
        continue;
      }

      if (imp.ns) {
        table.set(imp.ns, { kind: 'namespace', file: targetFile, depth: 0, overflow: false });
      }

      if (imp.defaultAlias) {
        const resolved = resolveSymbolIn(targetFile, 'default', 0);
        if (resolved?.id) {
          table.set(imp.defaultAlias, {
            kind: 'symbol',
            file: resolved.file,
            id: resolved.id,
            depth: resolved.depth,
            overflow: resolved.overflow,
          });
        } else {
          table.set(imp.defaultAlias, { kind: 'namespace', file: targetFile, depth: 0, overflow: false });
        }
      }

      if (imp.wildcard) {
        table.set('*', { kind: 'wildcard', file: targetFile, depth: 0, overflow: false });
      }

      for (const n of imp.names ?? []) {
        const localName = n.alias ?? n.name;
        if (file.lang === 'python') {
          const sub = pythonSubmoduleOf(targetFile, n.name);
          if (sub) {
            table.set(localName, { kind: 'namespace', file: sub, depth: 0, overflow: false });
            continue;
          }
        }
        const resolved = resolveSymbolIn(targetFile, n.name, 0);
        if (resolved?.id) {
          table.set(localName, {
            kind: 'symbol',
            file: resolved.file,
            id: resolved.id,
            depth: resolved.depth,
            overflow: resolved.overflow,
          });
        } else if (resolved?.moduleOnly) {
          table.set(localName, { kind: 'namespace', file: resolved.file, depth: resolved.depth, overflow: false });
        } else if (resolved?.overflow) {
          stats.barrelOverflows += 1;
          table.set(localName, { kind: 'fallback', file: resolved.lastHop, depth: resolved.depth });
        } else {
          table.set(localName, {
            kind: 'unresolved',
            depth: resolved?.depth ?? 0,
            overflow: Boolean(resolved?.overflow),
            lastHop: resolved?.lastHop ?? targetFile,
          });
        }
      }

      const importerMod = file._moduleNode.id;
      const targetMod = byPath.get(targetFile)?._moduleNode.id;
      if (targetMod) commitEdge(makeEdge(importerMod, targetMod, 'import', 'exact', file.path));
    }

    if (file.lang === 'go') {
      for (const imp of file.facts.imports) {
        const pkgFiles = resolveGoImport(imp.spec);
        if (!pkgFiles || pkgFiles.length === 0) {
          stats.unresolvedImports += 1;
          continue;
        }
        const pkgName =
          pkgFiles.map((f) => f.facts.packageName).find(Boolean) ??
          path.posix.basename(path.posix.dirname(imp.spec));
        const localName = imp.ns ?? pkgName;
        table.set(localName, {
          kind: 'gopackage',
          dir: path.posix.dirname(pkgFiles[0].path),
          files: pkgFiles.map((f) => f.path),
          depth: 0,
          overflow: false,
        });
        for (const f of pkgFiles) {
          const modId = f._moduleNode?.id;
          if (modId) commitEdge(makeEdge(file._moduleNode.id, modId, 'import', 'exact', file.path));
        }
      }
    } else if (file.lang === 'rust') {
      for (const imp of file.facts.imports) {
        const segs = Array.isArray(imp.segments) && imp.segments.length > 0 ? imp.segments : String(imp.spec ?? '').split('::');
        if (segs.length === 0 || segs[0] === '') continue;
        if (imp.wildcard) {
          const resolved = resolveRustSpec(segs.filter((s) => s !== '*'), file.path);
          if (!resolved) {
            stats.unresolvedImports += 1;
            continue;
          }
          table.set('*', { kind: 'wildcard', file: resolved.file, depth: 0, overflow: false });
          const targetMod = byPath.get(resolved.file)?._moduleNode.id;
          if (targetMod) commitEdge(makeEdge(file._moduleNode.id, targetMod, 'import', 'exact', file.path));
          continue;
        }
        const key = imp.ns ?? segs[segs.length - 1];
        const resolved = resolveRustSpec(segs, file.path, Boolean(imp.ns));
        if (!resolved) {
          stats.unresolvedImports += 1;
          continue;
        }
        const symName = imp.ns ? segs[segs.length - 1] : (resolved.item ?? segs[segs.length - 1]);
        let binding = null;
        if (symName) {
          const sym = resolveSymbolIn(resolved.file, symName, 0);
          if (sym?.id) {
            binding = { kind: 'symbol', file: sym.file, id: sym.id, depth: sym.depth, overflow: sym.overflow };
          } else if (sym?.moduleOnly) {
            binding = { kind: 'namespace', file: sym.file, depth: sym.depth, overflow: false };
          }
        }
        if (!binding) binding = { kind: 'namespace', file: resolved.file, depth: 0, overflow: false };
        table.set(key, binding);
        const targetMod = byPath.get(resolved.file)?._moduleNode.id;
        if (targetMod) commitEdge(makeEdge(file._moduleNode.id, targetMod, 'import', 'exact', file.path));
      }
    } else if (file.lang === 'java') {
      const wildcardPkgs = [];
      for (const imp of file.facts.imports) {
        if (imp.wildcard) {
          const pkgFiles = javaPackageFiles.get(String(imp.spec ?? '').replace(/\.\*$/, '')) ?? [];
          wildcardPkgs.push(...pkgFiles.map((f) => f.path));
          for (const f of [...pkgFiles].sort((a, b) => cmpStr(a.path, b.path))) {
            commitEdge(makeEdge(file._moduleNode.id, f._moduleNode.id, 'import', 'exact', file.path));
          }
          continue;
        }
        const resolved = resolveJavaSpec(imp);
        if (!resolved) {
          stats.unresolvedImports += 1;
          continue;
        }
        const targetMod = byPath.get(resolved.file)?._moduleNode.id;
        if (targetMod) commitEdge(makeEdge(file._moduleNode.id, targetMod, 'import', 'exact', file.path));
        if (resolved.classSymbol && !imp.static) {
          const sym = resolveSymbolIn(resolved.file, resolved.classSymbol, 0);
          if (sym?.id) {
            table.set(resolved.classSymbol, {
              kind: 'symbol',
              file: sym.file,
              id: sym.id,
              depth: sym.depth,
              overflow: sym.overflow,
            });
          } else {
            table.set(resolved.classSymbol, { kind: 'namespace', file: resolved.file, depth: 0, overflow: false });
          }
        }
        if (imp.static && resolved.staticMember) {
          const sym = resolveSymbolIn(resolved.file, resolved.staticMember, 0);
          if (sym?.id) {
            table.set(resolved.staticMember, {
              kind: 'symbol',
              file: sym.file,
              id: sym.id,
              depth: sym.depth,
              overflow: sym.overflow,
            });
          }
        }
      }
      if (wildcardPkgs.length > 0) file._wildcardJavaPackages = [...new Set(wildcardPkgs)].sort(cmpStr);
    } else if (file.lang === 'c-sharp') {
      const nsTargets = [];
      for (const imp of file.facts.imports) {
        const spec = String(imp.spec ?? '');
        if (!spec) continue;
        const nsFiles = csharpNamespaceFiles.get(spec);
        if (!nsFiles || nsFiles.length === 0) {
          stats.unresolvedImports += 1;
          continue;
        }
        nsTargets.push(...nsFiles.map((f) => f.path));
        for (const f of nsFiles) {
          commitEdge(makeEdge(file._moduleNode.id, f._moduleNode.id, 'import', 'exact', file.path));
        }
      }
      if (nsTargets.length > 0) file._usingNamespaces = [...new Set(nsTargets)].sort(cmpStr);
    }

    importTables.set(file.path, table);
  }

  const namespaceTypeBindings = new Map();
  const javaSamePackageBindings = new Map();
  for (const file of sorted) {
    if (file.lang === 'java') {
      const pkg = file.facts.packageName ?? '';
      if (!javaSamePackageBindings.has(pkg)) {
        const pkgMap = new Map();
        for (const targetPath of javaPackageFiles.get(pkg) ?? []) {
          const targetFile = byPath.get(targetPath);
          if (!targetFile) continue;
          for (const def of targetFile.facts.defs) {
            if (def.ownerKey || pkgMap.has(def.name)) continue;
            const id = defIdByKey.get(`${targetPath}|${def.key}`);
            if (id) pkgMap.set(def.name, { kind: 'symbol', file: targetPath, id, depth: 0, overflow: false });
          }
        }
        javaSamePackageBindings.set(pkg, pkgMap);
      }
    }
  }
  for (const file of sorted) {
    let targets = null;
    if (file.lang === 'c-sharp') targets = file._usingNamespaces ?? [];
    else if (file.lang === 'java') {
      const wildcard = file._wildcardJavaPackages ?? [];
      const ownPkgFiles = (javaPackageFiles.get(file.facts.packageName ?? '') ?? [])
        .map((f) => f.path)
        .filter((p) => p !== file.path);
      targets = [...new Set([...wildcard, ...ownPkgFiles])].sort(cmpStr);
    } else continue;
    if (targets.length === 0) continue;
    const map = new Map();
    for (const targetPath of targets) {
      const targetFile = byPath.get(targetPath);
      if (!targetFile) continue;
      const viaVisibility = file.lang === 'java' && !(file._wildcardJavaPackages ?? []).includes(targetPath);
      for (const def of targetFile.facts.defs) {
        if (def.ownerKey) continue;
        if (map.has(def.name)) continue;
        const id = defIdByKey.get(`${targetPath}|${def.key}`);
        if (!id) continue;
        map.set(def.name, {
          kind: 'symbol',
          file: targetPath,
          id,
          depth: 0,
          overflow: false,
          viaVisibility,
        });
      }
    }
    if (map.size > 0) namespaceTypeBindings.set(file.path, map);
  }
  for (const file of sorted) {
    const map = namespaceTypeBindings.get(file.path);
    if (map) file._nsTypes = map;
  }

  function headBinding(file, head) {
    const direct = importTables.get(file.path)?.get(head);
    if (direct) return direct;
    return file._nsTypes?.get(head) ?? null;
  }

  function sameFileDefId(file, name) {
    const list = definedNamesIn(file.path, name);
    return list.length > 0 ? list[0].id : null;
  }

  function isShadowed(file, call, head) {
    for (const l of file.facts.locals) {
      if (l.name === head && l.sb < call.sb) return true;
    }
    if (call.defKey) {
      const def = file.facts.defs.find((d) => d.key === call.defKey);
      if (def && def.paramTokens.includes(head)) return true;
    }
    return false;
  }

  function methodInClassOf(file, call, methodName) {
    if (!call.defKey) return null;
    const caller = file.facts.defs.find((d) => d.key === call.defKey);
    if (!caller) return null;
    let classKey = caller.kind === 'class' ? caller.key : caller.ownerKey;
    while (classKey) {
      const cls = file.facts.defs.find((d) => d.key === classKey);
      if (!cls) return null;
      const method = file.facts.defs.find((d) => d.ownerKey === cls.key && d.name === methodName);
      if (method) return defIdByKey.get(`${file.path}|${method.key}`);
      classKey = cls.ownerKey;
    }
    return null;
  }

  function symbolViaBinding(binding, memberName) {
    if (binding.kind === 'unresolved') return { dropped: true };
    if (binding.kind === 'fallback') {
      return { dst: byPath.get(binding.file)?._moduleNode.id ?? null, overflow: true };
    }
    if (binding.kind === 'gopackage') {
      for (const pkgFile of binding.files ?? []) {
        const found = resolveSymbolIn(pkgFile, memberName, binding.depth ?? 0);
        if (found?.id) return { dst: found.id, overflow: found.overflow };
        if (found?.overflow) {
          stats.barrelOverflows += 1;
          return { dst: byPath.get(found.lastHop)?._moduleNode.id ?? null, overflow: true };
        }
      }
      const firstMod = byPath.get((binding.files ?? [])[0])?._moduleNode.id;
      if (firstMod) return { dst: firstMod, overflow: false };
      return { dropped: true };
    }
    if (binding.kind === 'symbol') {
      if (memberName) {
        const member = resolveSymbolIn(binding.file, memberName, binding.depth ?? 0);
        if (member?.id) return { dst: member.id, overflow: member.overflow };
        if (member?.overflow) {
          stats.barrelOverflows += 1;
          return { dst: byPath.get(member.lastHop)?._moduleNode.id ?? null, overflow: true };
        }
      }
      return { dst: binding.id, overflow: binding.overflow };
    }
    if (binding.kind === 'wildcard') return { dropped: true };
    const resolved = resolveSymbolIn(binding.file, memberName, binding.depth);
    if (resolved?.id) return { dst: resolved.id, overflow: resolved.overflow };
    if (resolved?.moduleOnly) return { dst: byPath.get(resolved.file)?._moduleNode.id ?? null, overflow: false };
    if (resolved?.overflow) {
      stats.barrelOverflows += 1;
      return { dst: byPath.get(resolved.lastHop)?._moduleNode.id ?? null, overflow: true };
    }
    return { dropped: true };
  }

  for (const file of sorted) {
    for (const call of file.facts.calls) {
      const callerId = call.defKey ? defIdByKey.get(`${file.path}|${call.defKey}`) : file._moduleNode.id;
      if (!callerId) continue;

      if (call.selfRef && call.prop) {
        const dst = methodInClassOf(file, call, call.prop);
        if (dst) commitEdge(makeEdge(callerId, dst, 'call', 'heuristic', file.path));
        else stats.droppedCalls += 1;
        continue;
      }

      if (!isShadowed(file, call, call.head)) {
        const binding = headBinding(file, call.head);
        if (binding) {
          const outcome = symbolViaBinding(
            binding,
            binding.kind === 'symbol' && !call.prop ? call.head : (call.prop ?? call.head),
          );
          if (outcome.dropped || !outcome.dst) {
            stats.droppedCalls += 1;
          } else {
            commitEdge(
              makeEdge(callerId, outcome.dst, 'call', outcome.overflow ? 'heuristic' : 'exact', file.path),
            );
          }
          continue;
        }
        const localId = sameFileDefId(file, call.head);
        if (localId) {
          commitEdge(makeEdge(callerId, localId, 'call', 'heuristic', file.path));
          continue;
        }
      }
      stats.droppedCalls += 1;
    }

    for (const h of file.facts.heritage) {
      const classId = defIdByKey.get(`${file.path}|${h.defKey}`);
      if (!classId) continue;
      const headName = h.name.split('.')[0];
      const binding = headBinding(file, headName);
      let dst = null;
      let confidence = 'heuristic';
      if (binding) {
        if (binding.kind === 'symbol') {
          dst = binding.id;
          confidence = binding.overflow ? 'heuristic' : 'exact';
        } else if (binding.kind !== 'unresolved' && h.name.includes('.')) {
          const rest = h.name.split('.').slice(1).join('.');
          const outcome = symbolViaBinding({ ...binding, kind: binding.kind }, rest);
          if (outcome.dst) {
            dst = outcome.dst;
            confidence = outcome.overflow ? 'heuristic' : 'exact';
          }
        }
      } else if (!isShadowed(file, { sb: Number.MAX_SAFE_INTEGER, defKey: h.defKey }, headName)) {
        dst = sameFileDefId(file, headName);
        confidence = 'heuristic';
      }
      if (dst) commitEdge(makeEdge(classId, dst, h.rel, confidence, file.path));
    }

    for (const route of file.facts.routes) {
      const name = `${route.verb} ${route.path}`;
      const spanR = { sl: route.sl, sb: route.sb, el: route.el, eb: route.eb };
      const sigHash = nodeSigHash(name);
      const confidence = route.confidence === 'exact' ? 'exact' : 'heuristic';
      const routeNode = makeNode(NODE_PREFIX.route, 'route', file.lang, file.path, name, spanR, sigHash, {
        confidence,
      });
      nodes.push(routeNode);
      // Every other node kind gets `module contains <node>`; routes were the one kind
      // that did not, leaving them the only parentless nodes in the store. The `route`
      // edge below records which handler serves the route, which is a different fact
      // from which file the route lives in -- consumers that ask "what is in this file"
      // (store.parents, and anything walking containment) saw nothing for routes.
      commitEdge(makeEdge(file._moduleNode.id, routeNode.id, 'contains', 'exact', file.path));
      const srcId = route.defKey ? defIdByKey.get(`${file.path}|${route.defKey}`) : file._moduleNode.id;
      if (srcId) commitEdge(makeEdge(srcId, routeNode.id, 'route', confidence, file.path));
    }
  }

  for (const file of sorted) {
    const isGoTest = file.lang === 'go' && /_test\.go$/.test(file.path);
    const isRustIntegrationTest = file.lang === 'rust' && /(^|\/)tests\/[^/]+\.rs$/.test(file.path);
    if (!isTestFile(file.path) && !isGoTest && !isRustIntegrationTest && !(file.lang === 'c-sharp' && file.facts.testFramework)) continue;
    const targets = new Map();

    if (isGoTest) {
      const dir = path.posix.dirname(file.path);
      const pkg = file.facts.packageName ?? '';
      for (const other of sorted) {
        if (other.path === file.path || other.lang !== 'go') continue;
        if (path.posix.dirname(other.path) !== dir) continue;
        if (/_test\.go$/.test(other.path)) continue;
        if ((other.facts.packageName ?? '') !== pkg) continue;
        targets.set(other.path, 'heuristic');
      }
    } else if (isRustIntegrationTest) {
      if (rustCrateRoot && known.has(rustCrateRoot)) targets.set(rustCrateRoot, 'heuristic');
    } else {
      const table = importTables.get(file.path) ?? new Map();
      for (const [, binding] of [...table.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
        if (
          (binding.kind === 'symbol' || binding.kind === 'namespace' || binding.kind === 'wildcard') &&
          byPath.has(binding.file)
        ) {
          targets.set(binding.file, 'exact');
        }
      }
      const nsTypes = file._nsTypes;
      if (nsTypes) {
        for (const [, binding] of [...nsTypes.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
          if (byPath.has(binding.file)) {
            const confidence = binding.viaVisibility ? 'heuristic' : 'exact';
            const prev = targets.get(binding.file);
            if (prev !== 'exact') targets.set(binding.file, prev === 'heuristic' && confidence === 'heuristic' ? 'heuristic' : confidence);
          }
        }
      }
    }

    const convention = conventionTestTarget(file.path, file.lang);
    if (convention) {
      for (const other of sorted) {
        if (other.path === file.path) continue;
        if (moduleIdForFile(other.path, other.lang) === convention && !targets.has(other.path)) {
          targets.set(other.path, 'heuristic');
        }
      }
    }
    for (const [target, confidence] of [...targets.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
      commitEdge(makeEdge(file._moduleNode.id, byPath.get(target)._moduleNode.id, 'tests', confidence, file.path));
    }
  }

  const goInterfaceCandidates = [];
  for (const file of sorted) {
    if (file.lang !== 'go') continue;
    for (const def of file.facts.defs) {
      if (def.kind === 'interface' && Array.isArray(def.ifaceMethods) && def.ifaceMethods.length > 0) {
        goInterfaceCandidates.push({ file, def });
      }
    }
  }
  if (goInterfaceCandidates.length > 0) {
    const methodSetsByFile = new Map();
    for (const file of sorted) {
      if (file.lang !== 'go') continue;
      const setsByType = new Map();
      for (const def of file.facts.defs) {
        if (def.kind !== 'method' || !def.ownerKey) continue;
        const owner = file.facts.defs.find((d) => d.key === def.ownerKey);
        if (!owner || owner.kind !== 'class') continue;
        if (!setsByType.has(owner.name)) setsByType.set(owner.name, new Set());
        setsByType.get(owner.name).add(def.name);
      }
      if (setsByType.size > 0) methodSetsByFile.set(file.path, { file, setsByType });
    }
    for (const { file: consumerFile } of methodSetsByFile.values()) {
      const importedIfaceFiles = new Set([consumerFile.path]);
      // Same-package types are visible without an import in Go.
      const ownPkgDir = path.posix.dirname(consumerFile.path);
      for (const sibling of goPackageDirs.get(ownPkgDir) ?? []) importedIfaceFiles.add(sibling.path);
      for (const imp of consumerFile.facts.imports) {
        const pkgFiles = resolveGoImport(imp.spec);
        for (const f of pkgFiles ?? []) importedIfaceFiles.add(f.path);
      }
      const entry = methodSetsByFile.get(consumerFile.path);
      for (const [typeName, methodSet] of [...entry.setsByType.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
        for (const iface of goInterfaceCandidates) {
          if (!importedIfaceFiles.has(iface.file.path)) continue;
          if (iface.def.name === typeName) continue;
          const satisfied = iface.def.ifaceMethods.every((m) => methodSet.has(m));
          if (!satisfied) continue;
          const typeId = sameFileDefId(consumerFile, typeName);
          const ifaceId = defIdByKey.get(`${iface.file.path}|${iface.def.key}`);
          if (typeId && ifaceId) {
            commitEdge(makeEdge(typeId, ifaceId, 'implements', 'heuristic', consumerFile.path));
          }
        }
      }
    }
  }

  const seenIds = new Set();
  const finalNodes = nodes
    .filter((n) => {
      if (seenIds.has(n.id)) return false;
      seenIds.add(n.id);
      return true;
    })
    .map(({ _, ...rest }) => ({ _: 'node', ...rest }))
    .sort((a, b) =>
      cmpStr(`${a.id}|${a.path}|${a.name}`, `${b.id}|${b.path}|${b.name}`),
    );

  const finalEdges = [...edgeIndex.values()]
    .map(({ _, src, dst, type, label, confidence, f }) => ({
      _: 'edge',
      src,
      dst,
      type,
      label,
      confidence,
      f,
    }))
    .sort((a, b) => cmpStr(edgeKey(a), edgeKey(b)));

  return { nodes: finalNodes, edges: finalEdges, stats };
}
