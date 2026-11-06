/**
 * Reusable survey pipeline: fetch → coarse filter → KB retrieval → LLM
 * ranking → inspiration → optional PDF analysis → bilingual digest render.
 * Extracted so both the agent tool and the settings-page HTTP API share it.
 */

import { coarseFilter, fetchDay } from './arxiv.js';
import { targetDays, utc8Today } from './dates.js';
import * as kb from './kb.js';
import {
  FILTER_SYSTEM,
  INSPIRATION_SYSTEM,
  PDF_MAP_SYSTEM,
  PDF_REDUCE_SYSTEM,
  TRANSLATE_SYSTEM,
  chat,
  chatJson,
  filterUser,
  inspirationUser,
  translateUser,
  SUMMARIZE_ANALYSIS_SYSTEM,
  summarizeAnalysisUser,
} from './llm.js';
import { chunkText, fetchAndParsePdf } from './pdf.js';
import * as alphaxiv from './alphaxiv.js';

const DEFAULT_CATEGORIES = ['cs.CL', 'cs.AI', 'cs.LG', 'stat.ML'];
const MAX_PUSH_CAP = 5;
const RANK_BATCH = 40;
const MAX_CANDIDATES = 120; // candidates entering LLM ranking (3 batches)
const TOP_FOR_INSPIRATION = 10;

export const WEEKDAY_OPTIONS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

/** Deterministic bilingual digest (English + Chinese when available). */
function fallbackDigest(date, papers) {
  const parts = [`# arXiv 研究启发推荐 / arXiv Research Digest — ${date}`, ''];
  let missingTranslation = false;
  papers.forEach((p, i) => {
    parts.push(`## ${i + 1}. ${p.title}${p.title_zh ? ` / ${p.title_zh}` : ''}`);
    parts.push(`**Categories:** ${(p.categories || []).join(', ')}`);
    parts.push(`**Link:** ${p.url}`);
    parts.push('');
    parts.push('**Abstract / 摘要:**');
    parts.push(`> ${p.abstract}`);
    if (p.abstract_zh) parts.push(`> ${p.abstract_zh}`);
    else missingTranslation = true;
    parts.push('');
    parts.push('---');
  });
  if (missingTranslation) {
    parts.push(
      '_注：部分论文的中文翻译缺失，已回退为英文原文。 / Note: Some Chinese translations were unavailable; the original English abstract is shown._',
    );
  }
  return parts.join('\n');
}

/** Rule-based scoring fallback when the filter LLM fails (SPEC §12). */
function ruleScore(paper, profileText, researchContext) {
  const tokens = new Set(
    String(`${profileText} ${researchContext || ''}`)
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((t) => t.length > 3),
  );
  const hay = `${paper.title} ${paper.abstract}`.toLowerCase();
  let hits = 0;
  for (const token of tokens) if (hay.includes(token)) hits++;
  return {
    arxiv_id: paper.arxiv_id,
    topic_relevance: Math.min(10, hits),
    method_transferability: 5,
    novelty: 5,
    project_alignment: Math.min(10, hits),
    total: Math.min(40, hits * 2 + 10),
    brief_reason: 'rule-based keyword fallback scoring',
  };
}

async function rankPapers(ctx, { papers, profile, interestChunks, researchContext, signal, route }) {
  // Batches run concurrently: the llm service owns request scheduling, and
  // serial batches were the 600s-timeout bottleneck (22 batches × ~25s).
  const batches = [];
  for (let i = 0; i < papers.length; i += RANK_BATCH) {
    batches.push(papers.slice(i, i + RANK_BATCH));
  }
  const scored = (
    await Promise.all(
      batches.map(async (batch) => {
        try {
          const reply = await chatJson(ctx, {
            system: FILTER_SYSTEM,
            user: filterUser({ profile, interestChunks, researchContext, papers: batch }),
            signal,
            route,
          });
          return reply.scores || [];
        } catch (error) {
          ctx.logger.warn('arxiv-inspiration: filter LLM failed, using rule scoring: %s', error?.message);
          return batch.map((paper) => ruleScore(paper, profile, researchContext));
        }
      }),
    )
  ).flat();
  const byId = new Map(papers.map((p) => [p.arxiv_id, p]));
  return scored
    .filter((s) => byId.has(s.arxiv_id) && typeof s.total === 'number')
    .sort((a, b) => b.total - a.total)
    .slice(0, 20)
    .map((s) => ({ ...byId.get(s.arxiv_id), score: s.total, brief_reason: s.brief_reason }));
}

/** Chinese bullet summary of a deep-read analysis; degrade to plain prefix. */
async function summarizeAnalysis(ctx, { title, analysis, signal, route }) {
  try {
    const reply = await chat(ctx, {
      system: SUMMARIZE_ANALYSIS_SYSTEM,
      user: summarizeAnalysisUser({ title, analysis }),
      signal,
      route,
    });
    const lines = String(reply)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('-'));
    if (lines.length) return lines.join('\n');
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const plain = String(analysis)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `- ${plain.slice(0, 200)}…`;
}

/**
 * C-2 deep read: prefer the alphaXiv PDF query tool (reads only relevant
 * pages, far cheaper than a full map-reduce pass); on any failure fall back
 * to the local PyMuPDF + map-reduce pipeline. Both results land in the same
 * pdf_analysis cache.
 */
async function deepRead(ctx, { paper, motivation, useAlphaxivDeepRead, signal, route }) {
  if (useAlphaxivDeepRead !== false) {
    try {
      const queries = [motivation?.reason, motivation?.inspiration]
        .filter(Boolean)
        .map((q) => String(q).slice(0, 300));
      if (queries.length === 0) queries.push(`What are the key methods and results of ${paper.title}?`);
      const text = await alphaxiv.answerPdfQueries({ paper, queries }, signal);
      return `[alphaXiv deep read] ${text}`;
    } catch (error) {
      if (signal?.aborted) throw error;
      ctx.logger.warn('arxiv-inspiration: alphaXiv deep read failed, falling back to local PDF: %s', error?.message);
    }
  }
  return analyzeFullText(ctx, { paper, signal, route });
}

/** Map-reduce full-text analysis; never truncates the extracted text. */
async function analyzeFullText(ctx, { paper, signal, route }) {
  const fullText = await fetchAndParsePdf(paper, signal, kb);
  const chunks = chunkText(fullText);
  const notes = [];
  for (const chunk of chunks.slice(0, 8)) {
    try {
      notes.push(
        await chat(ctx, {
          system: PDF_MAP_SYSTEM,
          user: chunk,
          signal,
          route,
          maxTokens: 1024,
        }),
      );
    } catch (error) {
      ctx.logger.warn('arxiv-inspiration: PDF map pass failed for %s: %s', paper.arxiv_id, error?.message);
    }
  }
  if (notes.length === 0) return undefined;
  if (notes.length === 1) return notes[0];
  return chat(ctx, {
    system: PDF_REDUCE_SYSTEM,
    user: notes.map((n, i) => `## Chunk ${i + 1}\n${n}`).join('\n\n'),
    signal,
    route,
  });
}

/**
 * Run one full survey. `params` is already merged with plugin config:
 * { weekdays, categories, includeCrossList, maxPush, researchContext }.
 * `route` optionally overrides the LLM route { provider, model, reasoningEffort }.
 * Returns the complete result record (lossless-JSON-safe).
 */
export async function runSurvey(ctx, params, { signal, route } = {}) {
  const weekdays = params.weekdays?.length ? params.weekdays : ['friday', 'thursday', 'wednesday'];
  const categories =
    params.categories?.length ? params.categories.map(String) : DEFAULT_CATEGORIES;
  const includeCrossList = params.includeCrossList === true;
  const maxPush = Math.max(1, Math.min(MAX_PUSH_CAP, Number(params.maxPush) || MAX_PUSH_CAP));
  const researchContext = typeof params.researchContext === 'string' ? params.researchContext : '';
  const useAlphaxiv = params.useAlphaxivDiscovery !== false;
  const useAlphaxivDeepRead = params.useAlphaxivDeepRead !== false;

  const days = targetDays(weekdays);
  if (days.length === 0) {
    return { error: 'No valid weekdays matched within the past 7 days.' };
  }

  await kb.initIfMissing().catch(() => {});
  const [profile, pushedIds, negative] = await Promise.all([
    kb.getProfile(),
    kb.getPushedIds(),
    kb.buildNegativeSignals(),
  ]);

  const fetched = [];
  const fetchErrors = [];
  for (const day of days) {
    try {
      fetched.push(...(await fetchDay(day, categories, signal)));
    } catch (error) {
      if (signal?.aborted) throw error;
      fetchErrors.push(`${day.day}: ${error?.message ?? error}`);
    }
  }
  if (fetched.length === 0) {
    return {
      error: 'No papers matched the requested weekday/category window.',
      fetch_errors: fetchErrors,
    };
  }

  // C-1: alphaXiv semantic discovery supplement (quota-aware: ONE call per
  // survey). Catches cross-category papers the cat+weekday Atom query
  // structurally misses. Any failure degrades to the plain pipeline.
  let alphaxivNote = '';
  if (useAlphaxiv) {
    try {
      const interests = await kb.listInterests().catch(() => []);
      const keywords = [
        ...new Set(
          interests
            .flatMap((chunk) => chunk.tags ?? [])
            .filter((t) => t && t.length > 2),
        ),
      ].slice(0, 6);
      const question = `${researchContext || profile.slice(0, 200)} — recent papers that could inspire this research`.slice(0, 300);
      const discovered = await alphaxiv.discoverPapers({ keywords, question, difficulty: 3 }, signal);
      const seen = new Set(fetched.map((p) => p.arxiv_id));
      let merged = 0;
      for (const paper of discovered) {
        if (!seen.has(paper.arxiv_id)) {
          seen.add(paper.arxiv_id);
          fetched.push({
            ...paper,
            authors: paper.authors ?? [],
            abstract: paper.abstract || '',
            updated: paper.updated ?? paper.published ?? '',
            source: 'alphaxiv',
          });
          merged++;
        }
      }
      alphaxivNote = `alphaXiv 语义发现增补 ${merged} 篇（返回 ${discovered.length}）`;
      ctx.logger.info('arxiv-inspiration: %s', alphaxivNote);
    } catch (error) {
      if (signal?.aborted) throw error;
      alphaxivNote = `alphaXiv 发现增补不可用（已跳过）：${String(error?.message ?? error).slice(0, 120)}`;
      ctx.logger.warn('arxiv-inspiration: %s', alphaxivNote);
    }
  }

  // Library upsert (P0-1): every fetched paper enters papers.jsonl; new papers
  // also get queued for background semantic indexing.
  await kb.upsertPapers(fetched).catch((error) => {
    ctx.logger.warn('arxiv-inspiration: upsertPapers failed: %s', error?.message);
  });
  kb.indexPapersInBackground().catch(() => {});

  const filtered = coarseFilter(fetched, {
    includeCrossList,
    categories,
    pushedIds,
    excludeKeywords: [],
  }).filter((p) => !negative.directIds.has(p.arxiv_id));
  // Cap candidates before LLM ranking: arXiv returns submittedDate-descending
  // order, so the slice keeps the most recent papers. Without the cap, an
  // 850-paper week meant 22 serial ranking calls and a 600s timeout.
  const candidates = filtered.slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    return {
      fetched_count: fetched.length,
      agent_context: 'All fetched papers were already pushed or filtered out.',
      markdown: '',
      recommended: [],
    };
  }

  const interestChunks = await kb.searchInterest(
    `${researchContext} ${profile}`.trim() || profile,
    5,
  );

  const rankedRaw = await rankPapers(ctx, {
    papers: candidates,
    profile,
    interestChunks,
    researchContext,
    signal,
    route,
  });
  if (rankedRaw.length === 0) {
    return {
      fetched_count: fetched.length,
      agent_context: 'No papers survived ranking.',
      markdown: '',
      recommended: [],
    };
  }

  // Gentle negative-feedback down-ranking: each title-token overlap with the
  // rejected set lowers the score by 6%, capped at 25% total. One rejection
  // nudges; it never buries a whole topic (SPEC guard against over-filtering).
  const negTokens = new Set(negative.titleTokens);
  const ranked = rankedRaw
    .map((p) => {
      if (negTokens.size === 0) return p;
      const overlap = kb.tokenizeTitle(p.title).filter((t) => negTokens.has(t)).length;
      if (overlap === 0) return p;
      const penalty = Math.min(0.25, 0.06 * overlap);
      const adjusted = Math.max(0, Math.round(p.score * (1 - penalty)));
      return {
        ...p,
        score: adjusted,
        feedback_penalty: `${Math.round(penalty * 100)}% (overlap ${overlap})`,
      };
    })
    .sort((a, b) => b.score - a.score);

  let inspiration;
  // P3-9: inject the user's existing notes (on candidate papers + recent) so
  // the inspiration LLM adds to what the user already knows instead of
  // re-explaining it.
  const userNotes = await kb.notesForPrompt(ranked.map((p) => p.arxiv_id)).catch(() => ({
    onCandidates: [],
    recentUser: [],
  }));
  try {
    inspiration = await chatJson(ctx, {
      system: INSPIRATION_SYSTEM,
      user: inspirationUser({
        profile,
        interestChunks,
        researchContext,
        pushedIds,
        papers: ranked.slice(0, TOP_FOR_INSPIRATION),
        userNotes,
      }),
      signal,
      route,
    });
  } catch (error) {
    ctx.logger.warn('arxiv-inspiration: inspiration LLM failed: %s', error?.message);
    inspiration = {
      recommended: ranked.slice(0, maxPush).map((p) => ({
        arxiv_id: p.arxiv_id,
        title: p.title,
        score: p.score,
        reason: p.brief_reason || '按综合排序得分入选（未调用 LLM 生成推荐理由）。',
        inspiration: '启发生成 LLM 不可用，本篇按精排得分入选。',
        suggested_action: '先阅读摘要，判断是否与当前研究相关。',
        needs_pdf: false,
      })),
      agent_context: `Top-ranked relevant papers: ${ranked
        .slice(0, maxPush)
        .map((p) => `${p.title} (${p.url})`)
        .join('; ')}.`,
      skipped_summary: 'LLM 不可用，本次使用规则评分降级排序。',
    };
  }

  // On-demand PDF full-text analysis (map-reduce, never truncated).
  // Deep-read results are cached in the library (papers.jsonl pdf_analysis,
  // keyed to the paper's updated date) so a paper is only analyzed once.
  const pdfNotes = [];
  for (const rec of (inspiration.recommended || []).filter((r) => r.needs_pdf)) {
    const rankedPaper = ranked.find((p) => p.arxiv_id === rec.arxiv_id) ?? rec;
    try {
      const lib = await kb.getPaper(rec.arxiv_id);
      if (
        lib?.pdf_analysis &&
        (lib.pdf_analysis_version ?? '') === (rankedPaper.updated ?? '') &&
        rankedPaper.updated
      ) {
        rec.pdf_analysis = lib.pdf_analysis;
        rec.pdf_analysis_summary = lib.pdf_analysis_summary ?? '';
        rankedPaper.pdf_analysis_cached = lib.pdf_analysis;
        pdfNotes.push({ arxiv_id: rec.arxiv_id, analysis: lib.pdf_analysis, summary: lib.pdf_analysis_summary ?? '', cached: true });
        continue;
      }
      const analysis = await deepRead(ctx, {
        paper: rankedPaper,
        motivation: rec,
        useAlphaxivDeepRead,
        signal,
        route,
      });
      if (analysis) {
        // Full note → md file; cards get a Chinese bullet summary instead of
        // tens of KB of raw pages. Summary failure degrades to a plain prefix.
        const summary = await summarizeAnalysis(ctx, { title: rankedPaper.title, analysis, signal, route });
        const mdPath = await kb.writeAnalysis(rec.arxiv_id, { title: rankedPaper.title, analysis }).catch(() => null);
        rec.pdf_analysis = analysis;
        rec.pdf_analysis_summary = summary;
        rankedPaper.pdf_analysis_cached = analysis;
        rankedPaper.pdf_analysis_summary = summary;
        pdfNotes.push({ arxiv_id: rec.arxiv_id, analysis, summary, md_path: mdPath ?? undefined });
      }
    } catch (error) {
      rec.pdf_error = String(error?.message ?? error);
      if (/pymupdf|exit code 3|exited 3/.test(rec.pdf_error)) {
        rec.pdf_error += ' — install with: pip install pymupdf';
      }
    }
  }

  let agentContext = String(inspiration.agent_context || '');
  for (const note of pdfNotes) {
    // Agents get the compact summary plus the md archive path (they can read
    // the file for the full cited text) — not the full raw analysis inline.
    if (note.md_path === undefined && !note.summary) {
      agentContext += `\n\nFull-text analysis of ${note.arxiv_id}: ${note.analysis.slice(0, 4000)}`;
    } else {
      agentContext += `\n\nFull-text analysis of ${note.arxiv_id} (summary):\n${note.summary}\n(full note: ${note.md_path ?? kb.analysisPath(note.arxiv_id)})`;
    }
  }

  // Backfill metadata from fetched data so renderer/fallback have real values.
  const digestPapers = (inspiration.recommended || [])
    .slice(0, maxPush)
    .map((r) => {
      const paper = ranked.find((p) => p.arxiv_id === r.arxiv_id);
      return {
        ...r,
        title: paper?.title ?? r.title,
        abstract: paper?.abstract ?? r.abstract ?? '',
        categories: paper?.categories ?? r.categories ?? [],
        url: paper?.url ?? `https://arxiv.org/abs/${r.arxiv_id}`,
      };
    });

  const date = utc8Today();

  // Per-paper Simplified-Chinese translation (title + abstract) so the card can
  // render each paper bilingually in one place. One LLM call, JSON output.
  if (digestPapers.length > 0) {
    try {
      const translated = await chatJson(ctx, {
        system: TRANSLATE_SYSTEM,
        user: translateUser({ papers: digestPapers }),
        signal,
        route,
      });
      const byId = new Map((translated.papers || []).map((t) => [t.arxiv_id, t]));
      for (const paper of digestPapers) {
        const t = byId.get(paper.arxiv_id);
        if (t) {
          if (t.title_zh) paper.title_zh = String(t.title_zh);
          if (t.abstract_zh) paper.abstract_zh = String(t.abstract_zh);
        }
      }
    } catch (error) {
      ctx.logger.warn('arxiv-inspiration: translation LLM failed: %s', error?.message);
    }
  }

  // Deterministic bilingual markdown kept for the record and the digest push API.
  const markdown = digestPapers.length > 0 ? fallbackDigest(date, digestPapers) : '';

  // Library enrichment upsert: LLM scores, zh translations, and cached PDF
  // analyses flow back into papers.jsonl.
  {
    const enrichments = new Map();
    for (const p of ranked) {
      enrichments.set(p.arxiv_id, {
        score: p.score,
        title_zh: digestPapers.find((d) => d.arxiv_id === p.arxiv_id)?.title_zh,
        abstract_zh: digestPapers.find((d) => d.arxiv_id === p.arxiv_id)?.abstract_zh,
        pdf_analysis: p.pdf_analysis_cached ?? p.pdf_analysis,
        pdf_analysis_summary: p.pdf_analysis_summary ?? undefined,
      });
    }
    await kb.upsertPapers(ranked, { enrichments }).catch((error) => {
      ctx.logger.warn('arxiv-inspiration: enrich upsert failed: %s', error?.message);
    });
  }

  // Extended English list (title + abstract + link) for session injection:
  // more papers than the curated recommendation, deterministically rendered.
  const papersExtended = ranked.slice(0, 20).map((p) => ({
    arxiv_id: p.arxiv_id,
    title: p.title,
    abstract: p.abstract,
    categories: p.categories,
    url: p.url,
    score: p.score,
  }));

  return {
    date_utc8: date,
    weekdays,
    categories,
    fetched_count: fetched.length,
    candidate_count: filtered.length,
    ranked_count: candidates.length,
    recommended: digestPapers,
    papers_extended: papersExtended,
    agent_context: agentContext,
    skipped_summary: inspiration.skipped_summary ?? '',
    markdown,
    alphaxiv_note: alphaxivNote || undefined,
    fetch_errors: fetchErrors.length ? fetchErrors : undefined,
  };
}

/**
 * Render the session-injection payload: configurable English prompt followed
 * by an English list of papers (title + abstract + link), no LLM involved.
 */
export function renderInjection(papers, pushPrompt, { date, count } = {}) {
  const list = (papers || []).slice(0, count ?? papers?.length ?? 0);
  const lines = [
    pushPrompt || '',
    '',
    `Recent arXiv papers (fetched ${date ?? ''}, UTC+8):`,
    '',
  ];
  list.forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.title}`);
    lines.push(`- arXiv: ${p.arxiv_id} | Categories: ${(p.categories || []).join(', ')}`);
    lines.push(`- Link: ${p.url}`);
    lines.push(`- Abstract: ${p.abstract}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}
