/**
 * Local research-interest knowledge base at ~/.dsh-arxiv-inspiration/.
 * Pure filesystem access; initializes an empty structure on first use and
 * degrades to a no-KB mode when files are missing or unreadable.
 *
 * MVP retrieval: keyword/tag overlap scoring (vector index is an optional
 * future upgrade per SPEC §7).
 */

import { mkdir, readFile, readdir, appendFile, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildKeywordSpec, keywordRank } from './rank.js';

// DSH_ARXIV_INSPIRATION_HOME redirects the whole KB directory — test-only
// isolation knob (isolated verification without touching the live KB).
const KB_DIR = process.env.DSH_ARXIV_INSPIRATION_HOME
  || path.join(homedir(), '.dsh-arxiv-inspiration');
const PROFILE = path.join(KB_DIR, 'profile.md');
const INTERESTS = path.join(KB_DIR, 'interests.jsonl');
const PUSHED = path.join(KB_DIR, 'pushed_papers.jsonl');
const FEEDBACK = path.join(KB_DIR, 'feedback.jsonl');
const COLLECTION = path.join(KB_DIR, 'collection.jsonl'); // active push-list rows
const COLLECTION_REMOVED = path.join(KB_DIR, 'collection_removed.jsonl'); // tombstones
const PAPERS = path.join(KB_DIR, 'papers.jsonl'); // the paper-library base record
const FULLTEXT_DIR = path.join(KB_DIR, 'fulltext');
const VEC_SCRIPT = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  'scripts',
  'kb_vec.py',
);

async function ensureDir() {
  await mkdir(KB_DIR, { recursive: true });
}

async function readJsonl(file) {
  try {
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function appendJsonl(file, rows) {
  await ensureDir();
  const text = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await appendFile(file, text, 'utf8');
}

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((t) => t.length > 2),
  );
}

/** Keyword/tag-overlap retrieval over interests.jsonl; empty result is fine. */
export async function searchInterest(query, topK = 5) {
  const rows = await readJsonl(INTERESTS);
  if (rows.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return rows.slice(0, topK);
  const scored = rows.map((chunk) => {
    const chunkTokens = tokenize(`${chunk.text} ${(chunk.tags || []).join(' ')}`);
    let overlap = 0;
    for (const token of queryTokens) if (chunkTokens.has(token)) overlap++;
    return { chunk, score: overlap * (Number(chunk.weight) || 1) };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.chunk);
}

export async function getPushedIds() {
  const rows = await readJsonl(PUSHED);
  return rows.map((row) => row.arxiv_id);
}

export async function recordPushed(papers) {
  const now = new Date().toISOString();
  await appendJsonl(
    PUSHED,
    papers.map((p) => ({
      arxiv_id: p.arxiv_id,
      title: p.title,
      abstract: p.abstract,
      categories: p.categories,
      pushed_at: now,
    })),
  );
}

export async function recordFeedback(arxivId, feedback, title) {
  const row = { arxiv_id: arxivId, feedback, at: new Date().toISOString() };
  if (title) row.title = String(title).slice(0, 300);
  await appendJsonl(FEEDBACK, [row]);
}

/** All feedback rows (append-only log). */
export async function readFeedback() {
  return readJsonl(FEEDBACK);
}

/**
 * Aggregate negative feedback into gentle down-ranking signals:
 * - directIds: papers explicitly marked not_interested (latest wins per paper).
 * - titleTokens: tokens from those papers' titles (rows without a stored
 *   title contribute only the direct id). Token overlap feeds a SMALL score
 *   penalty at survey time; one rejection must not bury a whole topic.
 */
const NEG_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'using', 'via', 'based', 'toward', 'towards',
  'study', 'approach', 'method', 'methods', 'model', 'models', 'analysis',
  'learning', 'deep', 'neural', 'network', 'networks', 'data', 'new', 'novel',
]);

export function tokenizeTitle(title) {
  return [
    ...new Set(
      String(title ?? '')
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .filter((t) => t.length > 3 && !NEG_STOPWORDS.has(t)),
    ),
  ];
}

export async function buildNegativeSignals() {
  const rows = await readFeedback();
  const latest = new Map();
  for (const row of rows) {
    if (!row.arxiv_id) continue;
    latest.set(row.arxiv_id, row); // append order ⇒ last write wins
  }
  const directIds = new Set();
  const titleTokens = new Set();
  for (const row of latest.values()) {
    if (row.feedback !== 'not_interested') continue;
    directIds.add(row.arxiv_id);
    for (const token of tokenizeTitle(row.title)) titleTokens.add(token);
  }
  return { directIds, titleTokens: [...titleTokens] };
}

/**
 * Positive feedback → interest chunk. Idempotent per paper: the arXiv id is
 * embedded in the chunk text and checked against existing interests.
 */
export async function addInterestForPaper(paper) {
  const existing = await listInterests();
  if (existing.some((chunk) => String(chunk.text ?? '').includes(`arXiv:${paper.arxiv_id}`))) {
    return { added: false, reason: 'already-present' };
  }
  const firstSentence = String(paper.abstract ?? '').split(/(?<=[.!?])\s/)[0] ?? '';
  return {
    added: true,
    chunk: await addInterest({
      text: `[arXiv:${paper.arxiv_id}] ${paper.title} — ${firstSentence}`.slice(0, 600),
      tags: Array.isArray(paper.categories) ? paper.categories : [],
      weight: 2,
      source: 'feedback',
    }),
  };
}

export async function getProfile() {
  try {
    return (await readFile(PROFILE, 'utf8')).trim();
  } catch {
    return '';
  }
}

/** Replace the whole profile text (agent/user maintenance interface). */
export async function writeProfile(text) {
  await ensureDir();
  await writeFile(PROFILE, String(text), 'utf8');
}

/** List interest chunks from interests.jsonl. */
export async function listInterests() {
  return readJsonl(INTERESTS);
}

/** Append one interest chunk; returns the stored chunk with its id. */
export async function addInterest({ text, tags = [], weight = 1, source = 'manual' }) {
  if (!String(text ?? '').trim()) throw new Error('interest text must be non-empty');
  const chunk = {
    id: `int-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    text: String(text),
    tags: Array.isArray(tags) ? tags.map(String) : [tags].filter(Boolean).map(String),
    weight: Number(weight) || 1,
    source: ['manual', 'feedback', 'paper_read'].includes(source) ? source : 'manual',
    updated_at: new Date().toISOString(),
  };
  await appendJsonl(INTERESTS, [chunk]);
  return chunk;
}

/** Remove interest chunks by id; returns the number removed. */
export async function removeInterest(id) {
  const rows = await readJsonl(INTERESTS);
  const kept = rows.filter((row) => row.id !== id);
  if (kept.length === rows.length) return 0;
  await ensureDir();
  await writeFile(
    INTERESTS,
    kept.map((row) => JSON.stringify(row)).join('\n') + (kept.length ? '\n' : ''),
    'utf8',
  );
  return rows.length - kept.length;
}

/** Initialize the KB directory with an empty structure (SPEC §12). */
export async function initIfMissing() {
  await ensureDir();
  try {
    await readFile(PROFILE, 'utf8');
  } catch {
    await writeFile(
      PROFILE,
      [
        '# Research Interest Profile',
        '',
        'Describe your research interests, current projects, and stage here.',
        'This file feeds the paper-filtering LLM prompts.',
        '',
      ].join('\n'),
      'utf8',
    );
  }
}

// ---------------------------------------------------------------------------
// Paper library (papers.jsonl): every fetched paper, upserted by arxiv_id.
// ---------------------------------------------------------------------------

async function readPapersMap() {
  const rows = await readJsonl(PAPERS);
  return new Map(rows.filter((r) => r.arxiv_id).map((r) => [r.arxiv_id, r]));
}

/**
 * Upsert papers into the library. Merge semantics per arxiv_id:
 * metadata fields refresh, first_seen is kept, last_seen bumped,
 * `scores` appends {date, total} entries, zh translations and feedback
 * overwrite when provided. Returns the number of NEW papers added.
 */
export async function upsertPapers(papers, { enrichments } = {}) {
  const byId = new Map(
    (Array.isArray(papers) ? papers : []).filter((p) => p?.arxiv_id).map((p) => [p.arxiv_id, p]),
  );
  const enrich = enrichments ?? new Map();
  if (byId.size === 0) return 0;
  const existing = await readPapersMap();
  const today = new Date().toISOString().slice(0, 10);
  let added = 0;
  for (const [id, p] of byId) {
    const prev = existing.get(id);
    const e = enrich.get(id) ?? {};
    const next = {
      arxiv_id: id,
      title: p.title ?? prev?.title ?? '',
      abstract: p.abstract ?? prev?.abstract ?? '',
      authors: p.authors ?? prev?.authors ?? [],
      categories: p.categories ?? prev?.categories ?? [],
      url: p.url ?? prev?.url ?? `https://arxiv.org/abs/${id}`,
      pdf_url: p.pdf_url ?? prev?.pdf_url,
      published: p.published ?? prev?.published ?? '',
      updated: p.updated ?? prev?.updated ?? '',
      first_seen: prev?.first_seen ?? new Date().toISOString(),
      last_seen: new Date().toISOString(),
      scores: appendScore(prev?.scores, e.score !== undefined ? { date: today, total: e.score } : undefined),
      feedback: e.feedback ?? prev?.feedback,
      title_zh: e.title_zh ?? p.title_zh ?? prev?.title_zh,
      abstract_zh: e.abstract_zh ?? p.abstract_zh ?? prev?.abstract_zh,
      pdf_analysis: e.pdf_analysis ?? prev?.pdf_analysis,
      pdf_analysis_style: e.pdf_analysis_style ?? prev?.pdf_analysis_style,
      pdf_analysis_summary: e.pdf_analysis_summary ?? prev?.pdf_analysis_summary,
      pdf_analysis_version: e.pdf_analysis ? (p.updated ?? prev?.updated ?? '') : prev?.pdf_analysis_version,
      pushed_at: prev?.pushed_at,
      // Recheck/recommendation bookkeeping survives upserts (markRecommended /
      // markRechecked may have run earlier in the same pipeline).
      recheck_score: prev?.recheck_score,
      recheck_at: prev?.recheck_at,
      recommended_at: prev?.recommended_at,
      recommend_count: prev?.recommend_count,
      source: p.source ?? prev?.source ?? 'survey',
    };
    if (!prev) added++;
    existing.set(id, next);
  }
  await ensureDir();
  const rows = [...existing.values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
  await writeFile(PAPERS, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return added;
}

function appendScore(scores, entry) {
  if (!entry) return scores ?? [];
  const list = [...(scores ?? [])];
  if (list.length === 0 || list[list.length - 1].date !== entry.date || list[list.length - 1].total !== entry.total) {
    list.push(entry);
  }
  return list.slice(-20); // bounded history
}

/**
 * Mark papers as recommended by a survey. `recommended_at` is written once (the
 * first time the pipeline surfaced the paper), so the carry-over lane can tell
 * "seen but never recommended" from "already offered".
 */
export async function markRecommended(ids) {
  const wanted = new Set((ids ?? []).filter(Boolean));
  if (wanted.size === 0) return 0;
  const byId = await readPapersMap();
  const now = new Date().toISOString();
  let touched = 0;
  for (const id of wanted) {
    const row = byId.get(id);
    if (!row) continue;
    row.recommended_at = row.recommended_at ?? now;
    row.recommend_count = (Number(row.recommend_count) || 0) + 1;
    touched++;
  }
  if (touched === 0) return 0;
  await ensureDir();
  const rows = [...byId.values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
  await writeFile(PAPERS, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return touched;
}

/**
 * Library recheck candidate pool (库内重评). Watermark semantics:
 * - default: only papers never rechecked (no recheck_at) enter the pool;
 * - fullRescan: ignore the watermark and include everything.
 * Standing exclusions: 👎 not_interested feedback always stays out;
 * recommended_at / pushed papers stay out unless their include* flag is set.
 * since/until optionally bound first_seen (YYYY-MM-DD, UTC dates as stored).
 * Ordered newest-first (mirrors the survey pipeline's recency bias).
 */
export async function recheckCandidates({
  includeRecommended = false,
  includePushed = false,
  fullRescan = false,
  since = '',
  until = '',
} = {}) {
  const rows = await listPapers();
  const pushed = includePushed ? new Set() : new Set(await getPushedIds());
  const sinceTs = since ? Date.parse(`${since}T00:00:00Z`) : NaN;
  const untilTs = until ? Date.parse(`${until}T23:59:59Z`) : NaN;
  const out = [];
  for (const r of rows) {
    if (!r.arxiv_id) continue;
    if (r.feedback === 'not_interested') continue;
    if (!includeRecommended && r.recommended_at) continue;
    if (pushed.has(r.arxiv_id)) continue;
    if (!fullRescan && r.recheck_at) continue;
    const seen = Date.parse(r.first_seen ?? '');
    if (Number.isFinite(sinceTs) && (!Number.isFinite(seen) || seen < sinceTs)) continue;
    if (Number.isFinite(untilTs) && (!Number.isFinite(seen) || seen > untilTs)) continue;
    out.push(r);
  }
  out.sort((a, b) => ((a.first_seen ?? '') < (b.first_seen ?? '') ? 1 : -1));
  return out.map((r) => ({
    arxiv_id: r.arxiv_id,
    title: r.title ?? '',
    abstract: r.abstract ?? '',
    categories: r.categories ?? [],
    url: r.url ?? `https://arxiv.org/abs/${r.arxiv_id}`,
    first_seen: r.first_seen ?? '',
    title_zh: r.title_zh ?? '',
    abstract_zh: r.abstract_zh ?? '',
  }));
}

/**
 * Write recheck coarse scores back into papers.jsonl as independent fields
 * (recheck_score 0-10 + recheck_at) — deliberately not mixed into the survey
 * `scores` history. Unknown ids are ignored.
 */
export async function markRechecked(entries) {
  const list = (entries ?? []).filter((e) => e?.arxiv_id);
  if (list.length === 0) return 0;
  const byId = await readPapersMap();
  const now = new Date().toISOString();
  let touched = 0;
  for (const e of list) {
    const row = byId.get(e.arxiv_id);
    if (!row) continue;
    const raw = Number(e.score);
    row.recheck_score = Number.isFinite(raw) ? Math.max(0, Math.min(10, Math.round(raw))) : 0;
    row.recheck_at = now;
    touched++;
  }
  if (touched === 0) return 0;
  await ensureDir();
  const rows = [...byId.values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
  await writeFile(PAPERS, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return touched;
}

/**
 * Carry-over (回捞): papers fetched by an EARLIER survey inside the carry-over
 * window that were never recommended and never pushed. They get a second
 * chance instead of being lost to the newest-first truncation. Candidates are
 * ordered by interest-keyword overlap, then by recency, and go through the
 * normal hybrid recall + LLM ranking like every other candidate.
 */
export async function carryoverCandidates({
  days = 10,
  limit = 40,
  excludeIds = [],
  interestChunks = [],
} = {}) {
  const windowDays = Number(days);
  if (!(windowDays > 0) || !(limit > 0)) return [];
  const cutoff = Date.now() - windowDays * 24 * 3600 * 1000;
  const excluded = new Set((excludeIds ?? []).filter(Boolean));
  const rows = await listPapers();
  const pool = rows.filter(
    (p) =>
      p.arxiv_id &&
      !excluded.has(p.arxiv_id) &&
      !p.pushed_at &&
      !p.recommended_at &&
      Date.parse(p.last_seen ?? '') >= cutoff &&
      (p.title || p.abstract),
  );
  if (pool.length === 0) return [];
  const spec = buildKeywordSpec({ interestChunks });
  const byId = new Map(pool.map((p) => [p.arxiv_id, p]));
  const overlapping = keywordRank(pool, spec);
  const seenIds = new Set(overlapping);
  const ordered = [...overlapping, ...pool.map((p) => p.arxiv_id).filter((id) => !seenIds.has(id))];
  return ordered
    .slice(0, Math.min(limit, ordered.length))
    .map((id) => ({ ...byId.get(id), source: 'carryover', carryover: true }));
}

export async function listPapers() {
  return [...(await readPapersMap()).values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
}

export async function getPaper(id) {
  return (await readPapersMap()).get(id);
}

/** Library entry + deep-read-note state (path/existence/head) for one paper. */
export async function getPaperWithAnalysis(id) {
  const paper = (await readPapersMap()).get(id);
  const analysis = await readAnalysis(id);
  return {
    paper: paper ?? null,
    analysis_path: analysisPath(id),
    has_analysis: analysis !== undefined,
    analysis_head: analysis ? analysis.split('\n').slice(0, 8).join('\n') : undefined,
  };
}

/**
 * Keyword search over the library. Optional `semantic` tries the venv vector
 * index (scripts/kb_vec.py) and falls back to keywords on any failure.
 * Filters: category (substring), since (YYYY-MM-DD on first_seen/last_seen),
 * feedback, minScore (best recorded total), limit.
 */
/** Best recorded survey score for a library entry (0 when none). Recheck
 * coarse scores (0-10) join on the same 0-40 scale (×4) so library sorts
 * benefit from the latest re-evaluation even for never-surveyed papers. */
function bestScore(p) {
  return Math.max(
    0,
    ...(p.scores ?? []).map((s) => s.total ?? 0),
    (Number(p.recheck_score) || 0) * 4,
  );
}

/** Library sort orders. `recent` is the default (last_seen desc). */
const LIBRARY_SORTS = {
  recent: (a, b) => (a.last_seen < b.last_seen ? 1 : -1),
  score: (a, b) => bestScore(b) - bestScore(a) || (a.last_seen < b.last_seen ? 1 : -1),
  // Un-judged papers first (actionable feedback queue), then by score.
  unjudged: (a, b) => Number(Boolean(a.feedback)) - Number(Boolean(b.feedback))
    || bestScore(b) - bestScore(a),
  // Deep-read papers first, then by score.
  deepread: (a, b) => Number(Boolean(b.pdf_analysis)) - Number(Boolean(a.pdf_analysis))
    || bestScore(b) - bestScore(a),
  // Push-collection members first (the curated batch), then recency.
  collection: null, // handled in searchPapers (needs the live collection ids)
};

export async function searchPapers(query, { category, since, feedback, minScore, limit = 20, offset = 0, semantic = false, sort = 'recent' } = {}) {
  let papers = await listPapers();
  if (sort === 'collection') {
    // Members of the push collection first (curated batch), then recency.
    const inCollection = await collectionIds().catch(() => new Set());
    papers = papers.sort(
      (a, b) =>
        Number(inCollection.has(b.arxiv_id)) - Number(inCollection.has(a.arxiv_id))
        || (a.last_seen < b.last_seen ? 1 : -1),
    );
  } else {
    const sorter = LIBRARY_SORTS[sort] ?? LIBRARY_SORTS.recent;
    papers = papers.sort(sorter);
  }
  if (category) papers = papers.filter((p) => (p.categories ?? []).some((c) => c.includes(category)));
  if (since) papers = papers.filter((p) => (p.last_seen ?? '') >= since || (p.first_seen ?? '') >= since);
  if (feedback) papers = papers.filter((p) => p.feedback === feedback);
  if (minScore !== undefined) {
    papers = papers.filter((p) => Math.max(0, ...(p.scores ?? []).map((s) => s.total ?? 0)) >= minScore);
  }

  const q = String(query ?? '').trim();
  // offset applies to every exit path so callers can page through results.
  if (!q) return papers.slice(offset, offset + limit);

  if (semantic) {
    try {
      const ids = await vecSearch(q, papers.length);
      const rank = new Map(ids.map((id, i) => [id, i]));
      const hits = papers
        .filter((p) => rank.has(p.arxiv_id))
        .sort((a, b) => rank.get(a.arxiv_id) - rank.get(b.arxiv_id))
        .slice(offset, offset + limit);
      if (hits.length > 0) return hits;
    } catch {
      /* fall back to keyword scoring */
    }
  }
  const tokens = tokenizeTitle(q).length ? tokenizeTitle(q) : q.toLowerCase().split(/\s+/);
  return papers
    .map((p) => {
      const titleTokens = new Set(tokenizeTitle(p.title));
      const hay = `${p.title} ${p.abstract}`.toLowerCase();
      let s = 0;
      for (const t of tokens) {
        if (titleTokens.has(t)) s += 3;
        else if (hay.includes(t)) s += 1;
      }
      return { p, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(offset, offset + limit)
    .map((x) => x.p);
}

/** Run scripts/kb_vec.py search with the plugin venv; returns ranked ids. */
function vecSearch(query, topK) {
  return new Promise((resolve, reject) => {
    const child = spawn(venvPython(), [VEC_SCRIPT, 'search', '--query', query, '--top-k', String(topK)]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(out).ids ?? []);
        } catch (error) {
          reject(error);
        }
      } else reject(new Error(err.trim() || `kb_vec.py exited ${code}`));
    });
  });
}

/** Background semantic indexing of papers not yet in vectors.db (fire-and-forget). */
export async function indexPapersInBackground() {
  const papers = await listPapers();
  const payload = JSON.stringify(
    papers.map((p) => ({ id: p.arxiv_id, title: p.title, abstract: p.abstract, hash: `${p.title}|${(p.abstract ?? '').length}` })),
  );
  const child = spawn(venvPython(), [VEC_SCRIPT, 'index-batch', '--jsonl', payload], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.unref();
}

function venvPython() {
  const candidates = [
    // plugin-owned venv survives reinstalls best when placed in the data dir
    path.join(KB_DIR, '.venv', 'bin', 'python'),
    path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.venv', 'bin', 'python'),
    'python3',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'python3';
}

/**
 * Cosine similarity between each text and the best-matching query, computed
 * locally by fastembed (ONNX, no torch, no network after the model is cached).
 * Input travels over stdin: a 500-paper payload is far past argv limits.
 * Throws when the Python/venv side is unavailable — callers treat that as
 * "no semantic lane" and fall back to keyword-only recall.
 */
export function semanticScores(queries, texts, { timeoutMs = 180000, signal } = {}) {
  const qs = (queries ?? []).map((q) => String(q ?? '').trim()).filter(Boolean);
  const docs = (texts ?? []).map((t) => String(t ?? ''));
  if (docs.length === 0 || qs.length === 0) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn(venvPython(), [VEC_SCRIPT, 'score-texts']);
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(reject, new Error('semantic scoring aborted'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error('semantic scoring timed out'));
    }, timeoutMs);
    if (signal?.aborted) {
      clearTimeout(timer);
      return reject(new Error('semantic scoring aborted'));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(err.trim() || `kb_vec.py score-texts exited ${code}`));
        return;
      }
      try {
        finish(resolve, JSON.parse(out).scores ?? []);
      } catch (error) {
        finish(reject, error);
      }
    });
    child.stdin.on('error', () => {}); // EPIPE when the child dies early
    child.stdin.write(JSON.stringify({ queries: qs, texts: docs }));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Full-text archive (~/.dsh-arxiv-inspiration/fulltext/<id>.txt)
// ---------------------------------------------------------------------------

export function fulltextPath(arxivId) {
  return path.join(FULLTEXT_DIR, `${String(arxivId).replace(/[^0-9A-Za-z.\-]/g, '_')}.txt`);
}

export async function readFulltext(arxivId) {
  try {
    return await readFile(fulltextPath(arxivId), 'utf8');
  } catch {
    return undefined;
  }
}

export async function writeFulltext(arxivId, text) {
  await mkdir(FULLTEXT_DIR, { recursive: true });
  await writeFile(fulltextPath(arxivId), String(text), 'utf8');
}

// Deep-read analysis archive (~/.dsh-arxiv-inspiration/analyses/<id>.md)
// Full analyses live here as Markdown; cards show only the bullet summary.

export function analysisPath(arxivId) {
  return path.join(KB_DIR, 'analyses', `${String(arxivId).replace(/[^0-9A-Za-z.\-]/g, '_')}.md`);
}

export async function readAnalysis(arxivId) {
  try {
    return await readFile(analysisPath(arxivId), 'utf8');
  } catch {
    return undefined;
  }
}

export function rawAnalysisPath(arxivId) {
  return path.join(KB_DIR, 'analyses', `${String(arxivId).replace(/[^0-9A-Za-z.\-]/g, '_')}.raw.md`);
}

/** Raw deep-read material (alphaXiv page XML / map-reduce bullets), full fidelity. */
export async function readAnalysisRaw(arxivId) {
  try {
    return await readFile(rawAnalysisPath(arxivId), 'utf8');
  } catch {
    return undefined;
  }
}

// agentero paper-reader notes: an EXTERNAL vault, never copied or merged —
// <dir>/<arxivId>/NOTES.md with images under <dir>/<arxivId>/source/.
// We only ever reference them by absolute path (引用不合并).
export function agenteroNotePath(dir, arxivId) {
  const safe = String(arxivId).replace(/[^0-9A-Za-z.\-]/g, '_');
  return path.join(String(dir), safe, 'NOTES.md');
}

export async function readAgenteroNote(dir, arxivId) {
  if (!dir) return undefined;
  try {
    return await readFile(agenteroNotePath(dir, arxivId), 'utf8');
  } catch {
    return undefined;
  }
}

export async function writeAnalysisRaw(arxivId, { title, material, provenance }) {
  await mkdir(path.join(KB_DIR, 'analyses'), { recursive: true });
  const body = [
    `# 原始深读材料 · ${title}`,
    '',
    `- arXiv: https://arxiv.org/abs/${arxivId}`,
    `- 归档时间: ${new Date().toISOString()}`,
    `- 来源: ${provenance === 'alphaxiv' ? 'alphaXiv 页级检索' : '本地 PDF 全文解析'}`,
    '',
    '---',
    '',
    String(material ?? ''),
    '',
  ].join('\n');
  await writeFile(rawAnalysisPath(arxivId), body, 'utf8');
  return rawAnalysisPath(arxivId);
}

export async function writeAnalysis(arxivId, { title, analysis }) {
  const safe = String(arxivId).replace(/[^0-9A-Za-z.\-]/g, '_');
  await mkdir(path.join(KB_DIR, 'analyses'), { recursive: true });
  const text = String(analysis);
  // Text that already carries a markdown H1 header is written as-is, so
  // callers that compose their own header (tool write_analysis) are not
  // double-wrapped.
  const body = /^#\s/.test(text)
    ? text
    : `# 深读笔记 · ${title || safe}\n\n- arXiv: https://arxiv.org/abs/${safe}\n- 生成时间: ${new Date().toISOString()}\n\n---\n\n${text}`;
  await writeFile(analysisPath(arxivId), body, 'utf8');
  return analysisPath(arxivId);
}

// ---------------------------------------------------------------------------
// Paper notes (P3-9): notes.jsonl, append-only, user and agent authored.
// ---------------------------------------------------------------------------

const NOTES = path.join(KB_DIR, 'notes.jsonl');

export async function addNote({ arxiv_id: arxivId, text, author = 'user', session_id: sessionId }) {
  if (!arxivId || !String(text ?? '').trim()) throw new Error('note requires arxiv_id and text');
  const note = {
    arxiv_id: String(arxivId),
    text: String(text).slice(0, 4000),
    author: author === 'agent' ? 'agent' : 'user',
    at: new Date().toISOString(),
  };
  if (sessionId) note.session_id = String(sessionId);
  await appendJsonl(NOTES, [note]);
  return note;
}

export async function listNotes(arxivId) {
  const rows = await readJsonl(NOTES);
  return (arxivId ? rows.filter((n) => n.arxiv_id === arxivId) : rows)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Notes attached to the given candidate papers + recent user notes (for prompt injection). */
export async function notesForPrompt(candidateIds, recentLimit = 10) {
  const rows = await readJsonl(NOTES);
  const idSet = new Set(candidateIds);
  const onCandidates = rows.filter((n) => idSet.has(n.arxiv_id));
  const recentUser = rows
    .filter((n) => !idSet.has(n.arxiv_id))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, recentLimit);
  return { onCandidates, recentUser };
}

// ---------------------------------------------------------------------------
// Profile revision drafts (P2-6): proposed rewrites are staged in
// profile_draft.json and adopted explicitly; adopted history lives in
// profile_revisions/. profile.md is never modified silently.
// ---------------------------------------------------------------------------

const PROFILE_DRAFT = path.join(KB_DIR, 'profile_draft.json');
const PROFILE_REVISIONS = path.join(KB_DIR, 'profile_revisions');

export async function getProfileDraft() {
  try {
    return JSON.parse(await readFile(PROFILE_DRAFT, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveProfileDraft(draft) {
  await ensureDir();
  await writeFile(PROFILE_DRAFT, JSON.stringify({ ...draft, saved_at: new Date().toISOString() }, null, 2), 'utf8');
}

export async function clearProfileDraft() {
  await ensureDir();
  await writeFile(PROFILE_DRAFT, '', 'utf8');
}

export async function adoptProfileDraft(text) {
  const current = await getProfile();
  await ensureDir();
  await mkdir(PROFILE_REVISIONS, { recursive: true });
  if (current) {
    await writeFile(path.join(PROFILE_REVISIONS, `${Date.now()}.md`), current, 'utf8');
  }
  await writeFile(PROFILE, String(text), 'utf8');
  await clearProfileDraft();
  return { adopted: true, previous_archived: Boolean(current) };
}

/** Feedback entries newer than the newest archived profile revision. */
export async function feedbackSinceLastRevision() {
  const rows = await readJsonl(FEEDBACK);
  let sinceMs = 0;
  try {
    const files = (await readdir(PROFILE_REVISIONS))
      .filter((f) => f.endsWith('.md'))
      .map((f) => Number(f.replace('.md', '')))
      .filter((n) => Number.isFinite(n));
    if (files.length) sinceMs = Math.max(...files);
  } catch {
    /* no revisions yet */
  }
  if (!sinceMs) return rows;
  return rows.filter((r) => Date.parse(r.at ?? '') > sinceMs);
}


// ---------------------------------------------------------------------------
// Push collection (collection.jsonl): papers accumulated across surveys plus
// manual picks, pushed to a session in one shot. Removal semantics:
// - removeFromCollection(id) writes a tombstone so AUTO-collect skips the
//   paper in later surveys; a manual addToCollection clears the tombstone.
// - clearCollection() empties the active list WITHOUT tombstones (a finished
//   batch may legitimately be re-collected by the next survey).
// ---------------------------------------------------------------------------

/** Active collection rows: {arxiv_id, title, source, note, added_at}. */
export async function listCollection() {
  const rows = await readJsonl(COLLECTION);
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    if (!row.arxiv_id || seen.has(row.arxiv_id)) continue; // first add wins
    seen.add(row.arxiv_id);
    items.push(row);
  }
  return items;
}

/** Set of active arxiv_ids (cheap membership check for UI + auto-collect). */
export async function collectionIds() {
  return new Set((await listCollection()).map((r) => r.arxiv_id));
}

async function removedIds() {
  const rows = await readJsonl(COLLECTION_REMOVED);
  return new Set(rows.filter((r) => r.arxiv_id).map((r) => r.arxiv_id));
}

async function rewriteCollection(items) {
  await ensureDir();
  await writeFile(
    COLLECTION,
    items.map((row) => JSON.stringify(row)).join('\n') + (items.length ? '\n' : ''),
    'utf8',
  );
}

/**
 * Add one paper to the collection. Idempotent per arxiv_id (first add wins;
 * a repeat add only refreshes the snapshot title). `manual: true` (the
 * default) clears a previous tombstone so the paper can be auto-collected
 * again; auto-collect itself never clears tombstones.
 */
export async function addToCollection({
  arxiv_id: arxivId,
  title = '',
  source = 'manual',
  note = '',
  manual = true,
}) {
  const id = String(arxivId ?? '').trim();
  if (!/^[0-9]{4}\.[0-9]{4,5}(v[0-9]+)?$|^[a-z-]+(\.[a-z]{2})?\/[0-9]{7}$/i.test(id)) {
    throw new Error(`invalid arxiv id: ${arxivId}`);
  }
  const items = await listCollection();
  const existing = items.find((r) => r.arxiv_id === id);
  if (existing) {
    if (title && existing.title !== title) {
      existing.title = String(title);
      await rewriteCollection(items);
    }
    return { added: false, item: existing };
  }
  const item = {
    arxiv_id: id,
    title: String(title ?? ''),
    source: String(source ?? 'manual'),
    note: String(note ?? ''),
    added_at: new Date().toISOString(),
  };
  if (manual) {
    // drop the tombstone so later surveys may re-collect this paper
    const removed = [...(await removedIds())].filter((r) => r !== id);
    await ensureDir();
    await writeFile(
      COLLECTION_REMOVED,
      removed.map((r) => JSON.stringify({ arxiv_id: r })).join('\n') + (removed.length ? '\n' : ''),
      'utf8',
    );
  }
  await appendJsonl(COLLECTION, [item]);
  return { added: true, item };
}

/**
 * Auto-collect survey recommendations: skips ids already active and ids the
 * user removed (tombstones). Returns the number actually appended.
 */
export async function autoCollectRecommended(papers, surveyId = '') {
  const list = Array.isArray(papers) ? papers : [];
  if (!list.length) return 0;
  const active = await collectionIds();
  const removed = await removedIds();
  const fresh = [];
  for (const p of list) {
    const id = String(p?.arxiv_id ?? '').trim();
    if (!id || active.has(id) || removed.has(id)) continue;
    if (fresh.some((r) => r.arxiv_id === id)) continue;
    fresh.push({
      arxiv_id: id,
      title: String(p?.title ?? ''),
      source: surveyId ? `survey:${surveyId}` : 'survey',
      note: String(p?.reason ?? ''),
      added_at: new Date().toISOString(),
    });
    active.add(id);
  }
  if (!fresh.length) return 0;
  await appendJsonl(COLLECTION, fresh);
  return fresh.length;
}

/** Remove one paper from the active list and tombstone it. */
export async function removeFromCollection(arxivId) {
  const id = String(arxivId ?? '').trim();
  const items = await listCollection();
  const kept = items.filter((r) => r.arxiv_id !== id);
  if (kept.length === items.length) return false;
  await rewriteCollection(kept);
  if (!(await removedIds()).has(id)) {
    await appendJsonl(COLLECTION_REMOVED, [{ arxiv_id: id, removed_at: new Date().toISOString() }]);
  }
  return true;
}

/** Empty the active list without tombstones. Returns items cleared. */
export async function clearCollection() {
  const items = await listCollection();
  if (items.length) await rewriteCollection([]);
  return items.length;
}
