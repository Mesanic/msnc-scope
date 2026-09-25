import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  atomicWriteFile,
  cmpStr,
  contentHash,
  readJsonlLines,
  sha256Hex,
  toPosix,
} from './util.mjs';

export const SCHEMA_VERSION = 1;
export const TOOL_ID = 'scope-symbols@0.0.1';
export const SYMBOLS_DIRNAME = '.scope/symbols';
export const INDEX_DIRNAME = 'index';
export const LEDGER_DIRNAME = 'ledger';
export const NODES_SEGMENT = 'nodes-000.jsonl';
export const EDGES_SEGMENT = 'edges-000.jsonl';
export const FACTS_SEGMENT = 'facts-000.jsonl';
export const META_FILE = 'meta.json';
export const META_GOLDEN_EXCLUDED = ['createdAt', 'updatedAt', 'durationMs'];

export class IndexVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IndexVersionError';
  }
}

export function symbolsDirFor(projectRoot) {
  return path.join(path.resolve(projectRoot), SYMBOLS_DIRNAME);
}

export function ledgerDirFor(projectRoot) {
  return path.join(symbolsDirFor(projectRoot), LEDGER_DIRNAME);
}

export function storeDirFor(projectRoot) {
  return path.join(symbolsDirFor(projectRoot), INDEX_DIRNAME);
}

export function storePosixDirFor(projectRoot) {
  return toPosix(storeDirFor(projectRoot));
}

export function makeNodeId(prefix, posixPath, name, span, sigHash16) {
  const identity = `${posixPath}|${name}|${span.sl}:${span.sb}-${span.el}:${span.eb}|${sigHash16}`;
  return `${prefix}:${sha256Hex(identity).slice(0, 12)}`;
}

export function nodeSigHash(sigText) {
  return sha256Hex(sigText).slice(0, 16);
}

export async function writeSegment(absPath, records) {
  let out = '';
  for (const rec of records) out += JSON.stringify(rec) + '\n';
  await atomicWriteFile(absPath, out);
  return { count: records.length, bytes: Buffer.byteLength(out, 'utf8') };
}

export async function readSegment(absPath) {
  return readJsonlLines(absPath);
}

function metaPathFor(storeDir) {
  return path.join(storeDir, META_FILE);
}

export async function readMeta(storeDir) {
  let raw;
  try {
    raw = await readFile(metaPathFor(storeDir), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing', meta: null };
    throw err;
  }
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch (err) {
    return { status: 'corrupt', meta: null, error: err };
  }
  if (!meta || typeof meta !== 'object' || typeof meta.schemaVersion !== 'number') {
    return { status: 'corrupt', meta: null, error: new Error('meta.json missing numeric schemaVersion') };
  }
  const v = meta.schemaVersion;
  if (v > SCHEMA_VERSION) {
    throw new IndexVersionError(
      `symbols: index schemaVersion ${v} is newer than supported ${SCHEMA_VERSION}; run \`scope scan\` with an up-to-date Scope to rebuild`,
    );
  }
  return { status: v < SCHEMA_VERSION ? 'older' : 'ok', meta };
}

export async function writeMeta(storeDir, meta) {
  await atomicWriteFile(metaPathFor(storeDir), JSON.stringify(meta) + '\n');
}

export function sortRecordsByKey(records) {
  const keyed = records.map((rec) => ({ rec, key: JSON.stringify([rec.id ?? '', rec.src ?? '', rec.dst ?? '', rec.type ?? '']) }));
  keyed.sort((a, b) => cmpStr(a.key, b.key));
  return keyed.map((x) => x.rec);
}

export { contentHash, toPosix };
