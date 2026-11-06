/**
 * Minimal MCP streamable-http client for the alphaXiv endpoint.
 *
 * The endpoint and bearer token come from the locally installed
 * alphaxiv-mcp bundle (~/dsh-bundles/alphaxiv-mcp/cordis.patch.yml) so the
 * credential stays in ONE place. Every call here is best-effort: callers
 * must degrade gracefully when alphaXiv is unavailable (offline, quota,
 * missing bundle) — the arXiv/PyMuPDF pipeline remains the baseline.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PATCH_YML = path.join(homedir(), 'dsh-bundles', 'alphaxiv-mcp', 'cordis.patch.yml');
const ENDPOINT = 'https://api.alphaxiv.org/mcp/v1';

let cachedToken;
let sessionId;

/** Bearer token from the alphaxiv bundle patch; null when unavailable. */
export async function getToken() {
  if (cachedToken !== undefined) return cachedToken;
  try {
    const text = await readFile(PATCH_YML, 'utf8');
    const m = text.match(/Authorization:\s*['"]?Bearer\s+([A-Za-z0-9_-]+)/);
    cachedToken = m ? m[1] : null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

function parseMaybeSse(body, contentType) {
  if (!/text\/event-stream/i.test(contentType ?? '')) return JSON.parse(body);
  // Streamable HTTP may answer with SSE: take the last data: line holding JSON.
  const lines = body.split('\n').filter((l) => l.startsWith('data:'));
  for (let i = lines.length - 1; i >= 0; i--) {
    const data = lines[i].slice(5).trim();
    if (data && data !== '[DONE]') {
      try {
        return JSON.parse(data);
      } catch {
        /* try earlier line */
      }
    }
  }
  throw new Error('no JSON data line in SSE response');
}

async function post(rpc, { signal, withSession = true } = {}) {
  const token = await getToken();
  if (!token) throw new Error('alphaxiv token not found (bundle missing?)');
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (withSession && sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpc),
    signal,
  });
  const newSession = res.headers.get('Mcp-Session-Id');
  if (newSession) sessionId = newSession;
  if (!res.ok) {
    if (res.status === 404 && sessionId) {
      sessionId = undefined; // stale session — caller may re-initialize
      throw new Error('mcp session expired');
    }
    throw new Error(`alphaxiv HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseMaybeSse(text, res.headers.get('content-type'));
}

async function ensureSession(signal) {
  if (sessionId) return;
  const init = await post(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'dsh-arxiv-inspiration', version: '0.5' },
      },
    },
    { signal, withSession: false },
  );
  if (init.error) throw new Error(`initialize failed: ${init.error.message}`);
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { signal }).catch(() => {});
}

async function callTool(name, args, signal) {
  await ensureSession(signal);
  let reply;
  try {
    reply = await post({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }, { signal });
  } catch (error) {
    if (String(error.message).includes('session expired')) {
      reply = await post({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }, { signal });
    } else throw error;
  }
  if (reply.error) throw new Error(`alphaxiv ${name}: ${reply.error.message}`);
  const result = reply.result ?? {};
  if (result.isError) {
    const detail = (result.content ?? []).map((c) => c.text ?? '').join(' ');
    throw new Error(`alphaxiv ${name} tool error: ${detail.slice(0, 200)}`);
  }
  return result;
}

function resultText(result) {
  return (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

/**
 * C-1: semantic discovery supplement. One call per survey (quota-aware).
 * Returns [{arxiv_id, title, ...}] parsed from the tool's JSON text reply.
 */
export async function discoverPapers({ keywords, question, difficulty = 3 }, signal) {
  const result = await callTool(
    'discover_papers',
    { keywords, question, difficulty, prioritize: 'default' },
    signal,
  );
  const text = resultText(result);
  // Reply may be a JSON array or markdown lines like:
  //   [ID=2610.37596] **Title** (https://www.alphaxiv.org/abs/2610.37596). Published 2026-10-27 ...
  let papers;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) papers = parsed;
    } catch {
      /* markdown form below */
    }
  }
  if (!papers) {
    papers = [...text.matchAll(/\[ID=([^\]\s]+)\]\s*\*\*([^*]+)\*\*.*?Published\s+(\S+)/g)].map((m) => ({
      arxiv_id: m[1],
      title: m[2].trim(),
      published: m[3],
    }));
  }
  return papers
    .map((p) => ({
      arxiv_id: String(p.arxiv_id ?? p.paper_id ?? p.id ?? '').replace(/^.*abs\//, '').trim(),
      title: p.title ?? '',
      abstract: p.abstract ?? '',
      categories: Array.isArray(p.categories) ? p.categories : [],
      url: p.url ?? `https://arxiv.org/abs/${p.arxiv_id ?? p.paper_id ?? p.id ?? ''}`,
      published: p.published_date ?? p.published ?? '',
    }))
    .filter((p) => p.arxiv_id && p.title);
}

/**
 * C-2: query-based full-text read via the alphaXiv PDF tool. Cheaper than a
 * local map-reduce pass: only the relevant pages are read, with citations.
 */
export async function answerPdfQueries({ paper, queries }, signal) {
  const result = await callTool(
    'answer_pdf_queries',
    { paper: paper.arxiv_id, queries },
    signal,
  );
  const text = resultText(result);
  if (!text.trim()) throw new Error('empty answer_pdf_queries reply');
  return text;
}

export async function alphaxivAvailable() {
  return (await getToken()) !== null;
}
