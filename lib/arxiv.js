/**
 * arXiv Atom API fetcher with retry and light client-side filtering.
 * No XML dependency: the Atom feed is small and regular enough to parse
 * with anchored regexes per <entry>.
 */

import { submittedDateRange } from './dates.js';

const ARXIV_API = 'https://export.arxiv.org/api/query';
const USER_AGENT = 'dsh-arxiv-inspiration/0.1 (mailto:local-user)';

async function fetchWithRetry(url, signal, attempts = 3) {
  let delay = 3000;
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal,
      });
      if (!res.ok) throw new Error(`arXiv API HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delay));
      delay *= 3; // 3s, 9s exponential backoff per SPEC
    }
  }
  throw lastError;
}

function decodeXml(text) {
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]).trim() : '';
}

function parseEntry(block) {
  const idUrl = tag(block, 'id'); // http://arxiv.org/abs/2510.12345v2
  const m = idUrl.match(/abs\/([0-9.]+|[^/]+)(v\d+)?$/);
  if (!m) return undefined;
  const arxivId = m[1];
  const categories = [...block.matchAll(/<category[^>]*term="([^"]+)"/g)].map((c) => c[1]);
  const authors = [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((a) =>
    decodeXml(a[1].trim()),
  );
  const pdfMatch = block.match(/<arxiv:pdf[^>]*href="([^"]+)"/);
  return {
    arxiv_id: arxivId,
    title: tag(block, 'title').replace(/\s+/g, ' '),
    abstract: tag(block, 'summary').replace(/\s+/g, ' '),
    authors,
    categories,
    published: tag(block, 'published'),
    updated: tag(block, 'updated'),
    url: `https://arxiv.org/abs/${arxivId}`,
    pdf_url: pdfMatch ? pdfMatch[1] : `https://arxiv.org/pdf/${arxivId}`,
  };
}

/**
 * Fetch papers for one UTC+8 day and the given categories.
 * Returns a deduplicated paper array.
 */
export async function fetchDay(day, categories, signal) {
  const cats = categories.map((c) => `cat:${c}`).join('+OR+');
  const query = `(${cats})+AND+submittedDate:${submittedDateRange(day)}`;
  const url =
    `${ARXIV_API}?search_query=${query}&start=0&max_results=200` +
    `&sortBy=submittedDate&sortOrder=descending`;
  const xml = await fetchWithRetry(url, signal);
  const papers = [];
  const seen = new Set();
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const paper = parseEntry(match[1]);
    if (paper && paper.title && !seen.has(paper.arxiv_id)) {
      seen.add(paper.arxiv_id);
      papers.push(paper);
    }
  }
  return papers;
}

/** Fetch one paper's metadata by arXiv id (e.g. "2610.37596"). */
export async function fetchById(arxivId, signal) {
  const xml = await fetchWithRetry(`${ARXIV_API}?id_list=${encodeURIComponent(arxivId)}`, signal);
  const match = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!match) return undefined;
  return parseEntry(match[1]);
}

/** SPEC stage-1 coarse filter. */
export function coarseFilter(papers, { includeCrossList, categories, pushedIds, excludeKeywords }) {
  const pushed = new Set(pushedIds);
  const cats = new Set(categories);
  const keywords = (excludeKeywords || []).map((k) => String(k).toLowerCase());
  return papers.filter((p) => {
    if (pushed.has(p.arxiv_id)) return false;
    // alphaXiv discovery supplements are cross-category BY DESIGN (that is
    // their value over the cat+weekday Atom query) — exempt them from the
    // category filter so they survive into ranking. Carry-over papers were
    // already vetted when an earlier survey fetched them, so they are exempt
    // too (otherwise a cross-category alphaXiv paper could never come back).
    if (
      p.source !== 'alphaxiv' &&
      p.source !== 'carryover' &&
      !includeCrossList &&
      !cats.has(p.categories[0])
    ) {
      return false;
    }
    if (keywords.length) {
      const hay = `${p.title} ${p.abstract}`.toLowerCase();
      if (keywords.some((k) => hay.includes(k))) return false;
    }
    return true;
  });
}
