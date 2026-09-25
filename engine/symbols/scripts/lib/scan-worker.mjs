import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { getParser } from '../parsers/index.mjs';
import { extractForLang } from './extract.mjs';
import { extractUnknown } from './extract-unknown.mjs';
import { canonicalizeText, contentHash } from './util.mjs';
import { BINARY_SNIFF_BYTES, looksBinary } from './walk.mjs';

if (!workerData || !parentPort) {
  throw new Error('symbols: scan-worker.mjs must run inside a Worker');
}

const parsers = new Map();

async function parserFor(lang) {
  const cached = parsers.get(lang);
  if (cached) return cached;
  const handle = await getParser(lang);
  const query = await handle.loadQuery();
  const entry = { handle, query };
  parsers.set(lang, entry);
  return entry;
}

async function processJob(job) {
  const raw = await readFile(job.absPath);
  if (looksBinary(raw.subarray(0, BINARY_SNIFF_BYTES))) {
    return { path: job.posixPath, skipped: 'binary' };
  }
  const text = canonicalizeText(raw.toString('utf8'));
  const hash = contentHash(text);
  if (!job.lang) {
    return {
      path: job.posixPath,
      lang: 'unknown',
      hash,
      size: Buffer.byteLength(text, 'utf8'),
      facts: extractUnknown(job.posixPath, text, null, null),
    };
  }
  const { handle, query } = await parserFor(job.lang);
  const tree = handle.parse(text);
  let facts;
  try {
    facts = extractForLang(job.lang, job.posixPath, text, tree, query);
  } finally {
    tree.delete();
  }
  return {
    path: job.posixPath,
    lang: job.lang,
    hash,
    size: Buffer.byteLength(text, 'utf8'),
    facts,
  };
}

parentPort.postMessage({ type: 'ready', id: workerData.workerId });

parentPort.on('message', async (job) => {
  try {
    const result = await processJob(job);
    parentPort.postMessage({ type: 'done', result });
  } catch (err) {
    parentPort.postMessage({
      type: 'done',
      result: { path: job.posixPath, error: String((err && err.message) ?? err) },
    });
  }
});
