import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ledgerDirFor } from './store.mjs';
import { atomicWriteFile, canonicalizeText, cmpStr, readJsonlLines, sha256Hex } from './util.mjs';

/**
 * Notes ledger: append-only JSONL at <root>/.scope/symbols/ledger/notes.jsonl.
 *
 * Records are keyed by a content-derived "symbol-source hash" so they survive
 * moves: key = sha256(`${sigHash}|${dedentedBody}`)[:16]. When a symbol's node
 * id disappears from the index but exactly one live symbol carries the same
 * key, notes rebind to the new id; multiple identical candidates are flagged
 * as ambiguous and never silently picked.
 *
 * Appends go through an exclusive create-lock file (`notes.lock`) with brief
 * retries; writers that cannot acquire the lock fail cleanly and leave the
 * file untouched. Writes are read-modify-whole-file under the lock followed by
 * an atomic tmp+rename publish, so readers only ever see complete JSONL.
 */

export const LEDGER_SCHEMA_VERSION = 1;
export const NOTES_FILE = 'notes.jsonl';
export const LOCK_FILE = 'notes.lock';
export const LOCK_RETRY_ATTEMPTS = 160;
export const LOCK_RETRY_DELAY_MS = 25;
export const LOCK_STEAL_AFTER_MS = 10_000;

/** Thrown when the exclusive ledger lock could not be acquired in time. */
export class LedgerLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerLockError';
  }
}

/** Thrown when notes.jsonl exists but is not valid JSONL. */
export class LedgerCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LedgerCorruptError';
  }
}

export function notesPathFor(projectRoot) {
  return path.join(ledgerDirFor(projectRoot), NOTES_FILE);
}

export function displayKey(key) {
  return `src:${key}`;
}

/**
 * Normalize a function/class body for content hashing: strip BOM + CRLF,
 * trim trailing whitespace per line, drop leading/trailing blank lines, then
 * dedent by the smallest common indentation. Deterministic and platform-safe;
 * makes keys robust to pure re-indentation while still body-sensitive.
 */
export function normalizedBody(text) {
  const lines = canonicalizeText(String(text))
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''));
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start += 1;
  while (end > start && lines[end - 1] === '') end -= 1;
  const core = lines.slice(start, end);
  let minIndent = Infinity;
  for (const line of core) {
    if (line === '') continue;
    const indent = line.match(/^[ \t]*/)[0].length;
    if (indent < minIndent) minIndent = indent;
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;
  return core.map((line) => line.slice(minIndent)).join('\n');
}

/** The symbol-source hash: signature hash + normalized body. */
export function sourceKeyFor(sigHash, body) {
  return sha256Hex(`${sigHash}|${body}`).slice(0, 16);
}

export async function readSourceText(rootAbs, posixPath) {
  const raw = await readFile(path.join(rootAbs, ...posixPath.split('/')), 'utf8');
  return canonicalizeText(raw);
}

export async function sourceKeyForNode(rootAbs, node) {
  const text = await readSourceText(rootAbs, node.path);
  const lines = text.split('\n');
  const body = normalizedBody(lines.slice(node.span.sl - 1, node.span.el).join('\n'));
  return sourceKeyFor(node.sigHash, body);
}

/**
 * Compute source keys for every indexed node. Reads each tracked file once.
 * Returns { keyByNode: Map<nodeId,key>, nodesByKey: Map<key,[node,...]> } with
 * candidate lists sorted by node id (store.nodes is id-sorted).
 */
export async function computeSourceKeys(rootAbs, store) {
  const linesByPath = new Map();
  for (const relPath of [...store.trackedPaths].sort(cmpStr)) {
    try {
      const text = await readSourceText(rootAbs, relPath);
      linesByPath.set(relPath, text.split('\n'));
    } catch {
      continue;
    }
  }
  const keyByNode = new Map();
  const nodesByKey = new Map();
  for (const node of store.nodes) {
    const lines = linesByPath.get(node.path);
    if (!lines) continue;
    const slice = lines.slice(node.span.sl - 1, node.span.el).join('\n');
    const key = sourceKeyFor(node.sigHash, normalizedBody(slice));
    keyByNode.set(node.id, key);
    if (!nodesByKey.has(key)) nodesByKey.set(key, []);
    nodesByKey.get(key).push(node);
  }
  return { keyByNode, nodesByKey };
}

/** Record shapes use fixed insertion order — never rebuild via object iteration. */
export function makeSymbolNoteRecord({ key, node, text }) {
  return {
    _: 'note',
    v: LEDGER_SCHEMA_VERSION,
    op: 'set',
    kind: 'symbol',
    key,
    nodeId: node.id,
    path: node.path,
    span: { sl: node.span.sl, el: node.span.el },
    name: node.name,
    text,
  };
}

export function makeEdgeNoteRecord({ fromKey, fromNode, toKey, toNode, text }) {
  return {
    _: 'note',
    v: LEDGER_SCHEMA_VERSION,
    op: 'set',
    kind: 'edge',
    key: `${fromKey}->${toKey}`,
    fromKey,
    toKey,
    fromNodeId: fromNode.id,
    toNodeId: toNode.id,
    fromPath: fromNode.path,
    toPath: toNode.path,
    fromSpan: { sl: fromNode.span.sl, el: fromNode.span.el },
    toSpan: { sl: toNode.span.sl, el: toNode.span.el },
    text,
  };
}

export function rebindSymbolRecord(prev, newNode) {
  return {
    ...prev,
    nodeId: newNode.id,
    path: newNode.path,
    span: { sl: newNode.span.sl, el: newNode.span.el },
    name: newNode.name,
  };
}

function endpointFields(prefix, node) {
  return {
    [`${prefix}NodeId`]: node.id,
    [`${prefix}Path`]: node.path,
    [`${prefix}Span`]: { sl: node.span.sl, el: node.span.el },
  };
}

export function rebindEdgeRecord(prev, { fromNode, toNode }) {
  return {
    ...prev,
    ...(fromNode ? endpointFields('from', fromNode) : {}),
    ...(toNode ? endpointFields('to', toNode) : {}),
  };
}

/** Last-wins read model over the append-only record list. */
export function latestByKey(records) {
  const latest = new Map();
  for (const rec of records) {
    if (!rec || typeof rec !== 'object' || typeof rec.key !== 'string') continue;
    latest.set(rec.key, rec);
  }
  return latest;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding the exclusive ledger lock. Creates the lock with
 * 'wx' (Windows-safe), retries briefly on EEXIST, steals locks older than
 * LOCK_STEAL_AFTER_MS (crashed-writer recovery), releases via unlink.
 */
export async function withLedgerLock(
  ledgerDir,
  fn,
  opts = {},
) {
  const attempts = opts.attempts ?? LOCK_RETRY_ATTEMPTS;
  const delayMs = opts.delayMs ?? LOCK_RETRY_DELAY_MS;
  const stealAfterMs = opts.stealAfterMs ?? LOCK_STEAL_AFTER_MS;
  const lockPath = path.join(ledgerDir, LOCK_FILE);
  await mkdir(ledgerDir, { recursive: true });
  for (let attempt = 0; attempt < attempts; attempt++) {
    let handle = null;
    try {
      handle = await open(lockPath, 'wx');
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      if (stealAfterMs > 0) {
        try {
          const st = await stat(lockPath);
          if (Date.now() - st.mtimeMs > stealAfterMs) await unlink(lockPath);
        } catch {
          /* vanished or unreadable — just retry */
        }
      }
      await sleep(delayMs);
      continue;
    }
    try {
      return await fn();
    } finally {
      try {
        await handle.close();
      } finally {
        try {
          await unlink(lockPath);
        } catch {
          /* best-effort release */
        }
      }
    }
  }
  throw new LedgerLockError(
    `ledger is locked by another writer (${attempts} acquire attempts); no changes were written`,
  );
}

/**
 * Append records under the exclusive lock: read current JSONL, concatenate,
 * atomically republish. Concurrent writers serialize; each sees the other's
 * records because the read happens inside the lock.
 */
export async function appendNoteRecords(rootAbs, records, lockOpts = {}) {
  if (records.length === 0) return;
  const dir = ledgerDirFor(rootAbs);
  await mkdir(dir, { recursive: true });
  await withLedgerLock(dir, async () => {
    const filePath = path.join(dir, NOTES_FILE);
    let existing;
    try {
      existing = await readJsonlLines(filePath);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new LedgerCorruptError(
          `${NOTES_FILE} is not valid JSONL (${err.message}); fix or remove the file before writing notes`,
        );
      }
      throw err;
    }
    let out = '';
    for (const rec of [...existing, ...records]) out += `${JSON.stringify(rec)}\n`;
    await atomicWriteFile(filePath, out);
  }, lockOpts);
}

/**
 * Read all ledger records. Missing file -> []. Corrupt JSONL raises
 * LedgerCorruptError (never silently ignored).
 */
export async function readNotes(rootAbs) {
  try {
    return await readJsonlLines(notesPathFor(rootAbs));
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new LedgerCorruptError(
        `${NOTES_FILE} is not valid JSONL (${err.message}); run \`symbols.mjs init\` to recreate an empty ledger`,
      );
    }
    throw err;
  }
}
