import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

export function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalizeText(text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n/g, '\n');
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function contentHash(text) {
  return sha256Hex(canonicalizeText(text));
}

export function collapseWs(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

export function firstParagraph(text) {
  const body = String(text ?? '');
  if (!body.trim()) return null;
  const para = body.split(/\n\s*\n/)[0] ?? '';
  const collapsed = collapseWs(para);
  return collapsed ? collapsed : null;
}

let atomicSeq = 0;

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'ENOTEMPTY']);
const RENAME_RETRY_ATTEMPTS = 8;
const RENAME_RETRY_DELAY_MS = 25;

function sleepSync(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function atomicWriteFile(targetPath, data) {
  const dir = path.dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${atomicSeq++}`);
  try {
    await writeFile(tmp, data);
    // Windows: replace-renames can transiently fail while another process
    // holds a short-lived handle on the destination (antivirus/indexer or a
    // concurrent symbols writer). Bounded retry on exactly those codes.
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, targetPath);
        break;
      } catch (err) {
        if (attempt >= RENAME_RETRY_ATTEMPTS || !RENAME_RETRY_CODES.has(err?.code)) throw err;
        await sleepSync(RENAME_RETRY_DELAY_MS);
      }
    }
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* temp file may not exist if writeFile itself failed */
    }
    throw err;
  }
}

export async function readJsonlLines(absPath) {
  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    records.push(JSON.parse(line));
  }
  return records;
}

export function stableStringify(value) {
  return JSON.stringify(value);
}
