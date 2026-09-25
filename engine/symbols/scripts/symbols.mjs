#!/usr/bin/env node

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { IndexVersionError, scan } from './lib/scan.mjs';
import { IncompleteIndexError, StoreCorruptError, loadQueryStore } from './lib/query-store.mjs';
import { UsageError } from './lib/usage-error.mjs';
import { buildSearchIndex, formatHit, formatHitsJson, parseLimit, searchNodes } from './lib/locate.mjs';
import { assembleImpactReport, collectImpact } from './lib/impact.mjs';
import { SliceTooLargeError, buildSlice, expandTarget, readSourceLines } from './lib/slice.mjs';
import { buildBrief } from './lib/brief.mjs';
import { resolveKey } from './lib/resolve-key.mjs';
import {
  collectCheckReport,
  formatCheckReportHuman,
  formatCheckReportJson,
} from './lib/check.mjs';
import {
  LedgerCorruptError,
  LedgerLockError,
  appendNoteRecords,
  displayKey,
  makeEdgeNoteRecord,
  makeSymbolNoteRecord,
  sourceKeyForNode,
} from './lib/ledger.mjs';
import { initProject } from './lib/init.mjs';
import { collectStats, formatStats } from './lib/stats.mjs';
import { MAX_SOURCE_FILE_BYTES } from './lib/walk.mjs';
import { VIEWER_MAX_TOTAL_BYTES, ViewOutputError, generateViewFile } from './lib/view.mjs';

const SUBCOMMANDS = {
  scan: { milestone: 'M1', help: 'walk sources, extract symbols/edges into the store' },
  locate: { milestone: 'M2', help: 'find exact lines matching a symbol or pattern (BM25-ranked)' },
  impact: { milestone: 'M2', help: 'upstream callers + downstream deps + tests for a symbol' },
  slice: { milestone: 'M2', help: 'emit a token-budgeted code slice' },
  brief: { milestone: 'M2', help: 'compact orientation card for a symbol' },
  check: { milestone: 'M3', help: 'verify no dependent drift after edits' },
  note: { milestone: 'M3', help: 'append a human note to the ledger' },
  init: { milestone: 'M3', help: 'initialize .scope/symbols/ for a project' },
  stats: { milestone: 'M3', help: 'print store statistics' },
  view: { milestone: 'M5', help: 'render offline Graph/Flow/Change-Lens HTML viewer' },
};

function usage(stream = process.stderr) {
  stream.write("Scope symbol-graph engine - normally driven through `scope`\n");
  stream.write('\nusage: symbols.mjs <subcommand> [args]\n');
  stream.write('\nsubcommands:\n');
  for (const name of Object.keys(SUBCOMMANDS)) {
    const { help, milestone } = SUBCOMMANDS[name];
    stream.write(`  ${name.padEnd(8)} ${help} [${milestone}]\n`);
  }
  stream.write('\nSubcommands marked with a future milestone exit with code 2 until delivered.\n');
}

function usageFor(stream, name) {
  const spec = SUBCOMMANDS[name];
  stream.write(`usage: symbols.mjs ${name} [--root <dir>] [--full] [--jobs <n>]\n`);
  stream.write(`\n${spec?.help ?? ''}\n`);
}

/**
 * Generic flag parser. spec.options: name -> { key, type: 'flag'|'value',
 * valueKind: 'directory'|'number'|'integer', requiresMsg }.
 * Repeated flags are counted; positional args collected into out._.
 */
export function parseCommandArgs(argv, spec) {
  const out = { _: [], root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const def = spec.options[arg];
      if (!def) throw new UsageError(`unknown option "${arg}"`);
      if (def.type === 'flag') {
        out[def.key] = (out[def.key] ?? 0) + 1;
        continue;
      }
      if (i + 1 >= argv.length) throw new UsageError(def.requiresMsg);
      const raw = argv[++i];
      if (def.valueKind === 'number' || def.valueKind === 'integer') {
        const n = Number(raw);
        if (!Number.isFinite(n) || (def.valueKind === 'integer' && !Number.isInteger(n)) || n < 1) {
          throw new UsageError(`${arg} must be a positive ${def.valueKind}, got "${raw}"`);
        }
        out[def.key] = n;
      } else {
        out[def.key] = raw;
      }
    } else {
      if (spec.maxPositionals !== undefined && out._.length >= spec.maxPositionals) {
        throw new UsageError(`unexpected positional argument "${arg}"`);
      }
      out._.push(arg);
    }
  }
  return out;
}

export { UsageError };

export function parseScanArgs(argv) {
  const opts = parseCommandArgs(argv, {
    options: {
      '--root': { key: 'root', type: 'value', requiresMsg: '--root requires a directory argument' },
      '--jobs': {
        key: 'jobs',
        type: 'value',
        valueKind: 'number',
        requiresMsg: '--jobs requires a number argument',
      },
      '--full': { key: 'full', type: 'flag' },
    },
    maxPositionals: 0,
  });
  return { ...opts, full: Boolean(opts.full) };
}

const ROOT_OPT = () => ({
  '--root': { key: 'root', type: 'value', requiresMsg: '--root requires a directory argument' },
});

async function checkRoot(rootArg) {
  try {
    const rootStat = await stat(rootArg);
    if (!rootStat.isDirectory()) {
      console.error(`symbols: --root "${rootArg}" is not a directory`);
      return false;
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error(`symbols: --root "${path.resolve(rootArg)}" does not exist`);
      return false;
    }
    throw err;
  }
  return true;
}

function printOut(text) {
  process.stdout.write(text + '\n');
}

async function runScan(argv) {
  let opts;
  try {
    opts = parseScanArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`symbols: ${err.message}\n`);
      usageFor(process.stderr, 'scan');
      return 2;
    }
    throw err;
  }
  if (!(await checkRoot(opts.root))) return 2;
  const result = await scan(opts);
  const c = result.counts;
  console.error(
    `scan: ${c.tracked} files tracked · ${c.scanned} scanned · ${c.reused} reused` +
      `${c.skippedBinary ? ` · ${c.skippedBinary} binary skipped` : ''}` +
      `${c.skippedOversize ? ` · ${c.skippedOversize} oversize skipped (cap ${MAX_SOURCE_FILE_BYTES} B)` : ''}` +
      ` · ${c.nodes} nodes · ${c.edges} edges`,
  );
  console.error(`store: ${result.storePosixDir}${result.complete ? '' : ' (incomplete: see warnings)'}`);
  for (const w of result.warnings) {
    console.error(`warning: failed to extract ${w.path}: ${w.error}`);
  }
  for (const p of result.oversizeSkipped) {
    console.error(`note: skipped oversize source ${p} (over the ${MAX_SOURCE_FILE_BYTES}-byte cap; not indexed)`);
  }
  return 0;
}

async function runLocate(argv) {
  let opts;
  try {
    opts = parseCommandArgs(argv, {
      options: {
        ...ROOT_OPT(),
        '--limit': {
          key: 'limit',
          type: 'value',
          valueKind: 'integer',
          requiresMsg: '--limit requires a number argument',
        },
        '--json': { key: 'json', type: 'flag' },
      },
      maxPositionals: 1,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`symbols: ${err.message}\n`);
      process.stderr.write('usage: scope locate <query> [--root <dir>] [--limit <n>] [--json]\n');
      return 2;
    }
    throw err;
  }
  const query = (opts._[0] ?? '').trim();
  if (!query) {
    console.error('symbols: a search query is required\n');
    process.stderr.write('usage: scope locate <query> [--root <dir>] [--limit <n>] [--json]\n');
    return 2;
  }
  if (!(await checkRoot(opts.root))) return 2;

  const store = await loadQueryStore(opts.root);
  const index = buildSearchIndex(store.nodes);
  const hits = searchNodes(index, query, opts.limit);
  if (hits.length === 0) {
    printOut(`no results for "${query}"`);
    return 0;
  }
  printOut(opts.json ? formatHitsJson(query, hits) : hits.map((h) => formatHit(h.node)).join('\n'));
  return 0;
}

async function runImpact(argv) {
  let opts;
  try {
    opts = parseCommandArgs(argv, {
      options: {
        ...ROOT_OPT(),
        '--up': { key: 'up', type: 'flag' },
        '--down': { key: 'down', type: 'flag' },
        '--both': { key: 'both', type: 'flag' },
        '--depth': {
          key: 'depth',
          type: 'value',
          valueKind: 'integer',
          requiresMsg: '--depth requires a number argument',
        },
      },
      maxPositionals: 1,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`symbols: ${err.message}\n`);
      process.stderr.write('usage: scope impact <key> [--up|--down|--both] [--depth <n>] [--root <dir>]\n');
      return 2;
    }
    throw err;
  }
  const dirCount = [opts.up, opts.down, opts.both].filter(Boolean).length;
  if (dirCount > 1) throw new UsageError('choose one direction: --up, --down, or --both');
  const direction = opts.up ? 'up' : opts.both ? 'both' : 'down';
  const key = opts._[0];
  if (!key) {
    console.error('symbols: a symbol key is required (node id or unique name)\n');
    process.stderr.write('usage: scope impact <key> [--up|--down|--both] [--depth <n>] [--root <dir>]\n');
    return 2;
  }
  if (!(await checkRoot(opts.root))) return 2;

  const store = await loadQueryStore(opts.root);
  const target = resolveKey(store, key, { allowRange: false });
  const impact = collectImpact(store, target.node.id, direction, opts.depth);
  printOut(assembleImpactReport(target.node, direction, impact));
  return 0;
}

async function runSlice(argv) {
  let opts;
  try {
    opts = parseCommandArgs(argv, {
      options: {
        ...ROOT_OPT(),
        '--expand': { key: 'expand', type: 'flag' },
        '--max-tokens': {
          key: 'maxTokens',
          type: 'value',
          valueKind: 'integer',
          requiresMsg: '--max-tokens requires a number argument',
        },
      },
      maxPositionals: 1,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`symbols: ${err.message}\n`);
      process.stderr.write('usage: scope slice <key|path:a-b> [--expand] [--max-tokens <n>] [--root <dir>]\n');
      return 2;
    }
    throw err;
  }
  const key = opts._[0];
  if (!key) {
    console.error('symbols: a key is required: node id, symbol name, or path:a-b\n');
    process.stderr.write('usage: scope slice <key|path:a-b> [--expand] [--max-tokens <n>] [--root <dir>]\n');
    return 2;
  }
  if (!(await checkRoot(opts.root))) return 2;

  const store = await loadQueryStore(opts.root);
  let target = resolveKey(store, key, { allowRange: true });
  const expandSteps = opts.expand ?? 0;
  for (let i = 0; i < expandSteps; i++) target = expandTarget(store, target);

  const symbol =
    target.kind === 'node'
      ? { name: target.node.name, kind: target.node.kind, confidence: target.node.confidence }
      : null;
  const spanInfo =
    target.kind === 'node'
      ? { path: target.node.path, sl: target.node.span.sl, el: target.node.span.el, symbol }
      : { path: target.path, sl: target.sl, el: target.el, symbol };
  const lines = await readSourceLines(path.resolve(opts.root), spanInfo.path);
  const slice = buildSlice(lines, spanInfo, opts.maxTokens);
  printOut(slice.text);
  return 0;
}

async function runBrief(argv) {
  let opts;
  try {
    opts = parseCommandArgs(argv, { options: { ...ROOT_OPT() }, maxPositionals: 1 });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`symbols: ${err.message}\n`);
      process.stderr.write('usage: scope brief <key> [--root <dir>]\n');
      return 2;
    }
    throw err;
  }
  const key = opts._[0];
  if (!key) {
    console.error('symbols: a symbol key is required\n');
    process.stderr.write('usage: scope brief <key> [--root <dir>]\n');
    return 2;
  }
  if (!(await checkRoot(opts.root))) return 2;

  const store = await loadQueryStore(opts.root);
  const target = resolveKey(store, key, { allowRange: false });
  printOut(await buildBrief(store, path.resolve(opts.root), target));
  return 0;
}

const CHECK_USAGE = 'usage: scope check [--root <dir>] [--json]\n';
const NOTE_USAGE = 'usage: scope note symbol set <key> --text "..." | note symbol edge <fromKey> <toKey> --text "..." [--root <dir>]\n';
const INIT_USAGE = 'usage: scope scan [--root <dir>]\n';
const STATS_USAGE = 'usage: scope stats [--root <dir>]\n';

async function runCheck(argv) {
  let opts;
  try {
    opts = parseCommandArgs(argv, {
      options: { ...ROOT_OPT(), '--json': { key: 'json', type: 'flag' } },
      maxPositionals: 0,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`symbols: ${err.message}\n`);
      process.stderr.write(CHECK_USAGE);
      return 2;
    }
    throw err;
  }
  if (!(await checkRoot(opts.root))) return 2;

  const report = await collectCheckReport(path.resolve(opts.root));
  printOut(opts.json ? formatCheckReportJson(report) : formatCheckReportHuman(report));
  // Exit discipline: non-zero WHILE any drift/dangling/orphan/ambiguous issue
  // remains; zero only once the tree verifies clean.
  return report.issues > 0 ? 1 : 0;
}

async function resolveNoteKey(store, rootAbs, rawKey) {
  const target = resolveKey(store, rawKey, { allowRange: false });
  const key = await sourceKeyForNode(rootAbs, target.node);
  return { node: target.node, key };
}

async function runNote(argv) {
  let opts;
  try {
    opts = parseCommandArgs(argv, {
      options: { ...ROOT_OPT(), '--text': { key: 'text', type: 'value', requiresMsg: '--text requires a string argument' } },
      maxPositionals: 3,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`symbols: ${err.message}\n`);
      process.stderr.write(NOTE_USAGE);
      return 2;
    }
    throw err;
  }
  const sub = opts._[0];
  const text = typeof opts.text === 'string' ? opts.text : '';
  if ((sub !== 'set' && sub !== 'edge') || (sub === 'set' && opts._.length !== 2) || (sub === 'edge' && opts._.length !== 3)) {
    console.error('symbols: expected `note set <key>` or `note symbol edge <fromKey> <toKey>` with --text\n');
    process.stderr.write(NOTE_USAGE);
    return 2;
  }
  if (!text.trim()) {
    console.error('symbols: a non-empty --text is required\n');
    process.stderr.write(NOTE_USAGE);
    return 2;
  }
  if (!(await checkRoot(opts.root))) return 2;

  const rootAbs = path.resolve(opts.root);
  const store = await loadQueryStore(rootAbs);
  let record;
  if (sub === 'set') {
    const { node, key } = await resolveNoteKey(store, rootAbs, opts._[1]);
    record = makeSymbolNoteRecord({ key, node, text });
    await appendNoteRecords(rootAbs, [record]);
    printOut(`note set ${displayKey(key)} -> ${node.id} (${node.path}:${node.span.sl}-${node.span.el})`);
  } else {
    const from = await resolveNoteKey(store, rootAbs, opts._[1]);
    const to = await resolveNoteKey(store, rootAbs, opts._[2]);
    record = makeEdgeNoteRecord({ fromKey: from.key, fromNode: from.node, toKey: to.key, toNode: to.node, text });
    await appendNoteRecords(rootAbs, [record]);
    printOut(`note edge ${displayKey(from.key)}->${displayKey(to.key)} (${from.node.id} -> ${to.node.id})`);
  }
  return 0;
}

function printInitResult(res) {
  printOut(`init ${res.symbolsDirPosix}`);
  printOut(`index: ${res.metaWritten ? 'created (placeholder meta; first scan replaces it)' : 'existing'}`);
  printOut(`ledger notes.jsonl: v${res.ledgerSchemaVersion} ${res.notesCreated ? 'created' : 'existing'} (tracked in git, never gitignored)`);
  printOut(`gitignore: ${res.gitignoreStatus} (.scope/symbols/index/ and view-data.html ignored; .scope/symbols/ledger/ stays tracked)`);
  if (res.wholesaleIgnore) {
    console.error('warning: .gitignore ignores .scope/symbols/ entirely — un-ignore .scope/symbols/ledger/ or notes will be lost');
  }
}

async function runInit(argv) {
  let opts;
  try {
    opts = parseCommandArgs(argv, { options: { ...ROOT_OPT() }, maxPositionals: 0 });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`symbols: ${err.message}\n`);
      process.stderr.write(INIT_USAGE);
      return 2;
    }
    throw err;
  }
  if (!(await checkRoot(opts.root))) return 2;
  printInitResult(await initProject(path.resolve(opts.root)));
  return 0;
}

async function runStats(argv) {
  let opts;
  try {
    opts = parseCommandArgs(argv, { options: { ...ROOT_OPT() }, maxPositionals: 0 });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`symbols: ${err.message}\n`);
      process.stderr.write(STATS_USAGE);
      return 2;
    }
    throw err;
  }
  if (!(await checkRoot(opts.root))) return 2;
  printOut(formatStats(await collectStats(opts.root)));
  return 0;
}

const VIEW_USAGE = 'usage: scope view [--root <dir>] [--out <file>]\n';

async function runView(argv) {
  let opts;
  try {
    opts = parseCommandArgs(argv, {
      options: {
        ...ROOT_OPT(),
        '--out': { key: 'out', type: 'value', requiresMsg: '--out requires a file path argument' },
      },
      maxPositionals: 0,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`symbols: ${err.message}\n`);
      process.stderr.write(VIEW_USAGE);
      return 2;
    }
    throw err;
  }
  if (!(await checkRoot(opts.root))) return 2;

  const res = await generateViewFile({ root: opts.root, out: opts.out });
  printOut(
    `view ${res.outPosix} (${res.shownNodes} of ${res.totalNodes} symbols, ` +
      `${res.shownEdges} of ${res.totalEdges} relations, ${res.totalBytes} bytes)`,
  );
  if (res.truncated) {
    console.error(
      `warning: embedded graph was truncated to fit the ${VIEWER_MAX_TOTAL_BYTES}-byte ` +
        'self-contained limit; the viewer shows an explicit truncation banner with exact counts',
    );
  }
  return 0;
}

const HANDLERS = {
  scan: runScan,
  locate: runLocate,
  impact: runImpact,
  slice: runSlice,
  brief: runBrief,
  check: runCheck,
  note: runNote,
  init: runInit,
  stats: runStats,
  view: runView,
};

async function main(argv) {
  const cmd = argv[0];
  if (!cmd) {
    usage();
    return 2;
  }
  const sub = SUBCOMMANDS[cmd];
  if (!sub) {
    console.error(`symbols: unknown subcommand "${cmd}"\n`);
    usage();
    return 2;
  }
  const handler = HANDLERS[cmd];
  if (!handler) {
    console.error(`symbols: "${cmd}" is not implemented until ${sub.milestone}`);
    return 2;
  }
  return handler(argv.slice(1));
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof IndexVersionError) {
      console.error(`symbols: ${err.message}`);
      process.exitCode = 2;
    } else if (
      err instanceof UsageError ||
      err instanceof IncompleteIndexError ||
      err instanceof SliceTooLargeError ||
      err instanceof StoreCorruptError ||
      err instanceof ViewOutputError
    ) {
      console.error(`symbols: ${err.message}`);
      process.exitCode = 2;
    } else if (err instanceof LedgerCorruptError || err instanceof LedgerLockError) {
      // Operational ledger failures: not user error, but the write did not land.
      console.error(`symbols: ${err.message}`);
      process.exitCode = 1;
    } else {
      console.error(`symbols: ${err?.stack ?? err}`);
      process.exitCode = 1;
    }
  });
