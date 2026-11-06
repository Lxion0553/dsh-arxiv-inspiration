/**
 * On-demand PDF download + full-text extraction via PyMuPDF
 * (scripts/pdf_parse.py), per SPEC §11. Never truncates extracted text;
 * the map-reduce LLM pass lives in llm-logic.js.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(PLUGIN_DIR, 'scripts', 'pdf_parse.py');

/**
 * Prefer the plugin-owned venv interpreter (<plugin>/.venv/bin/python), which
 * carries pymupdf; fall back to PATH python3 when the venv is absent (the
 * script then reports the pip install hint itself).
 */
function pythonExecutable() {
  const candidates = [
    // data-dir venv survives plugin reinstalls; plugin-dir venv also honored
    path.join(homedir(), '.dsh-arxiv-inspiration', '.venv', 'bin', 'python'),
    path.join(PLUGIN_DIR, '.venv', 'bin', 'python'),
    path.join(PLUGIN_DIR, '.venv', 'bin', 'python3'),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return 'python3';
}

function execPython(script, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable(), [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(stdout);
      else reject(new Error(`pdf_parse.py exited ${code}: ${stderr.trim() || 'no stderr'}`));
    });
  });
}

/** Download + parse one paper PDF; returns the FULL text (never truncated).
 * Extracted text is archived under ~/.dsh-arxiv-inspiration/fulltext/<id>.txt
 * and reused on later requests (P1: full-text archive). */
export async function fetchAndParsePdf(paper, signal, kb) {
  if (kb?.readFulltext) {
    const archived = await kb.readFulltext(paper.arxiv_id);
    if (archived !== undefined) return archived;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'arxiv-pdf-'));
  try {
    const res = await fetch(paper.pdf_url, {
      headers: { 'User-Agent': 'dsh-arxiv-inspiration/0.1' },
      signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`PDF download HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const pdfPath = path.join(dir, `${paper.arxiv_id.replace(/[^0-9.]/g, '_')}.pdf`);
    await writeFile(pdfPath, bytes);
    const text = await execPython(SCRIPT, [pdfPath], signal);
    if (kb?.writeFulltext && text.trim()) {
      await kb.writeFulltext(paper.arxiv_id, text).catch(() => {});
    }
    return text;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Split full text into ~chunkChar chunks on paragraph boundaries without
 * dropping any content: every character of the input appears in exactly one
 * chunk (no tail truncation).
 */
export function chunkText(text, chunkChars = 24000) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkChars, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end);
      if (boundary > start + chunkChars / 2) end = boundary + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
