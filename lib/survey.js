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
  inspirationSystem,
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
import {
  buildKeywordSpec,
  estimateTokens,
  keywordRank,
  packBatches,
  rrfFuse,
  semanticRank,
} from './rank.js';
import * as alphaxiv from './alphaxiv.js';

const DEFAULT_CATEGORIES = ['cs.CL', 'cs.AI', 'cs.LG', 'stat.ML'];
// 推送篇数硬上限。推荐数（maxPush）不得超过推送篇数（pushCount），
// 两者都受这里约束：pushCount 最大 50，maxPush 最大等于 pushCount。
export const PUSH_COUNT_MAX = 50;
const MAX_DEEP_READS = 10; // per survey, keeps PDF/alphaXiv cost bounded
// 启发阶段单次调用的输入预算：pushCount 可以到 50，但 50 篇完整摘要会撑爆上下文，
// 所以窗口按 token 预算截断（至少保留 1 篇）。
const INSPIRATION_TOKEN_BUDGET = 24000;
const TRANSLATE_BATCH_TOKENS = 9000; // per translation call
const DEFAULT_MAX_CANDIDATES = 200; // candidates entering LLM ranking
const DEFAULT_RANK_TOKEN_BUDGET = 18000; // tokens per ranking call
const DEFAULT_ABSTRACT_CHARS = 1600; // per-paper ceiling inside a batch
const SEMANTIC_POOL = 500; // newest papers embedded for the semantic recall lane

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

async function rankPapers(
  ctx,
  {
    papers,
    profile,
    interestChunks,
    researchContext,
    signal,
    route,
    tokenBudget = DEFAULT_RANK_TOKEN_BUDGET,
    abstractChars = DEFAULT_ABSTRACT_CHARS,
  },
) {
  // Batches are packed to a TOKEN budget (not a fixed paper count) and run
  // concurrently: the llm service owns request scheduling, and serial batches
  // were the old 600s-timeout bottleneck. Packing to tokens keeps every call's
  // prompt bounded while letting short-abstract batches hold more papers.
  const batches = packBatches(papers, { tokenBudget, abstractChars });
  const scored = (
    await Promise.all(
      batches.map(async (batch) => {
        try {
          const reply = await chatJson(ctx, {
            system: FILTER_SYSTEM,
            user: filterUser({ profile, interestChunks, researchContext, papers: batch, abstractChars }),
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
  const ranked = scored
    .filter((s) => byId.has(s.arxiv_id) && typeof s.total === 'number')
    .sort((a, b) => b.total - a.total)
    .slice(0, 20)
    .map((s) => ({ ...byId.get(s.arxiv_id), score: s.total, brief_reason: s.brief_reason }));
  const estimatedTokens = batches.reduce(
    (sum, batch) =>
      sum +
      batch.reduce(
        (s, p) => s + estimateTokens(p.title) + estimateTokens(p.abstract) + 12,
        0,
      ),
    0,
  );
  return { ranked, batchCount: batches.length, estimatedTokens };
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
 * Translate (title + abstract) into Simplified Chinese in token-budgeted
 * batches. A failed batch is logged and skipped; the caller keeps English.
 * Returns a Map keyed by arxiv_id.
 */
async function translateInBatches(ctx, papers, { signal, route } = {}) {
  const out = new Map();
  let batch = [];
  let tokens = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    tokens = 0;
    try {
      const translated = await chatJson(ctx, {
        system: TRANSLATE_SYSTEM,
        user: translateUser({ papers: current }),
        signal,
        route,
      });
      for (const t of translated.papers || []) out.set(t.arxiv_id, t);
    } catch (error) {
      ctx.logger.warn(
        'arxiv-inspiration: translation batch failed (%d papers): %s',
        current.length,
        error?.message,
      );
    }
  };
  for (const paper of papers) {
    const cost = estimateTokens(`${paper.title ?? ''}\n${paper.abstract ?? ''}`) + 16;
    if (batch.length > 0 && tokens + cost > TRANSLATE_BATCH_TOKENS) await flush();
    batch.push(paper);
    tokens += cost;
  }
  await flush();
  return out;
}

/**
 * Resolve the two paper budgets used by one survey.
 * - pushCount: the paper budget for this run, clamped to PUSH_COUNT_MAX;
 *   0 (or missing) means "use the full budget" = PUSH_COUNT_MAX.
 * - maxPush: how many papers are recommended to the user, and therefore how
 *   many are fed to the inspiration LLM; 0 means "follow pushCount"; an explicit
 *   value is clamped to pushCount.
 */
export function resolvePaperBudget(params = {}) {
  const rawPush = Number(params.pushCount);
  const pushCount =
    Number.isFinite(rawPush) && rawPush > 0
      ? Math.min(PUSH_COUNT_MAX, Math.floor(rawPush))
      : PUSH_COUNT_MAX;
  const rawMax = Number(params.maxPush);
  const wanted = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : pushCount;
  return { pushCount, maxPush: Math.min(wanted, pushCount) };
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
  // 论文预算：pushCount 是本次调研的"论文预算"（注入给会话 agent 的条数上限，
  // 也是推荐数的天花板），maxPush 是推荐给用户的篇数，永远不超过 pushCount。
  const { pushCount, maxPush } = resolvePaperBudget(params);
  const pushLimit = maxPush;
  const researchContext = typeof params.researchContext === 'string' ? params.researchContext : '';
  const useAlphaxiv = params.useAlphaxivDiscovery !== false;
  const useAlphaxivDeepRead = params.useAlphaxivDeepRead !== false;
  const hybridRanking = params.hybridRanking !== false;
  const maxCandidates = Math.max(
    20,
    Math.min(500, Number(params.maxCandidates) || DEFAULT_MAX_CANDIDATES),
  );
  const rankTokenBudget = Math.max(
    4000,
    Math.min(60000, Number(params.rankTokenBudget) || DEFAULT_RANK_TOKEN_BUDGET),
  );
  const abstractChars = Math.max(
    400,
    Math.min(4000, Number(params.abstractChars) || DEFAULT_ABSTRACT_CHARS),
  );
  const carryoverDays = Math.max(0, Math.min(30, Number(params.carryoverDays ?? 10) || 0));
  const carryoverLimit = Math.max(0, Math.min(200, Number(params.carryoverLimit ?? 40) || 0));

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

  // Library upsert (P0-1): every FRESHLY fetched paper enters papers.jsonl;
  // new papers also get queued for background semantic indexing. Carry-over
  // papers are deliberately excluded: bumping their last_seen would extend
  // their window on every run and they would never age out.
  await kb.upsertPapers(fetched).catch((error) => {
    ctx.logger.warn('arxiv-inspiration: upsertPapers failed: %s', error?.message);
  });
  kb.indexPapersInBackground().catch(() => {});

  const interestChunks = await kb.searchInterest(
    `${researchContext} ${profile}`.trim() || profile,
    5,
  );

  // Carry-over (回捞): papers from an earlier survey inside the window that were
  // never recommended or pushed get a second chance instead of being lost to
  // the newest-first truncation. Bounded, and still subject to every filter.
  let carryover = [];
  if (carryoverLimit > 0) {
    carryover = await kb
      .carryoverCandidates({
        days: carryoverDays,
        limit: carryoverLimit,
        excludeIds: [...pushedIds, ...negative.directIds],
        interestChunks,
      })
      .catch((error) => {
        ctx.logger.warn('arxiv-inspiration: carryover failed: %s', error?.message);
        return [];
      });
  }

  const pool = carryover.length ? [...fetched, ...carryover] : fetched;
  const filtered = coarseFilter(pool, {
    includeCrossList,
    categories,
    pushedIds,
    excludeKeywords: [],
  }).filter((p) => !negative.directIds.has(p.arxiv_id));
  if (filtered.length === 0) {
    return {
      fetched_count: fetched.length,
      carryover_count: carryover.length,
      agent_context: 'All fetched papers were already pushed or filtered out.',
      markdown: '',
      recommended: [],
    };
  }

  // Candidate recall: instead of keeping only the newest N papers, run two
  // cheap lanes over the WHOLE filtered pool and fuse their rankings with RRF
  // (rank-based, so incomparable score scales do not matter; a missing lane
  // simply does not vote).
  const byId = new Map(filtered.map((p) => [p.arxiv_id, p]));
  let candidates;
  let keywordLaneSize = 0;
  let semanticLaneSize = 0;
  if (hybridRanking && filtered.length > maxCandidates) {
    const keywordLane = keywordRank(
      filtered,
      buildKeywordSpec({ profile, interestChunks, researchContext }),
    );
    keywordLaneSize = keywordLane.length;
    let semanticLane = [];
    const semanticPool = filtered.slice(0, SEMANTIC_POOL);
    try {
      const queries = [
        researchContext,
        ...interestChunks.map((c) => `${c.text} ${(c.tags ?? []).join(' ')}`),
        profile,
      ]
        .map((q) => String(q ?? '').trim())
        .filter(Boolean)
        .map((q) => q.slice(0, 1000))
        .slice(0, 4);
      const scores = await kb.semanticScores(
        queries,
        semanticPool.map((p) => `${p.title}\n${String(p.abstract ?? '').slice(0, 900)}`),
        { signal },
      );
      semanticLane = semanticRank(semanticPool, scores);
      semanticLaneSize = semanticLane.length;
    } catch (error) {
      if (signal?.aborted) throw error;
      ctx.logger.warn('arxiv-inspiration: semantic lane unavailable, keyword-only recall: %s', error?.message);
    }
    const fused = rrfFuse([keywordLane, semanticLane]);
    candidates = fused
      .slice(0, maxCandidates)
      .map((id) => byId.get(id))
      .filter(Boolean);
    // No lane voted (e.g. empty profile and no interests) → recency fallback.
    if (candidates.length === 0) candidates = filtered.slice(0, maxCandidates);
  } else {
    // Hybrid off, or the pool already fits the budget: newest-first.
    candidates = filtered.slice(0, maxCandidates);
  }
  if (candidates.length === 0) {
    return {
      fetched_count: fetched.length,
      carryover_count: carryover.length,
      agent_context: 'No candidates survived recall.',
      markdown: '',
      recommended: [],
    };
  }

  const { ranked: rankedRaw, batchCount, estimatedTokens } = await rankPapers(ctx, {
    papers: candidates,
    profile,
    interestChunks,
    researchContext,
    signal,
    route,
    tokenBudget: rankTokenBudget,
    abstractChars,
  });
  if (rankedRaw.length === 0) {
    return {
      fetched_count: fetched.length,
      carryover_count: carryover.length,
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

  // Record that these papers were offered, so the carry-over lane will not
  // surface them again inside its window.
  await kb.markRecommended(ranked.map((p) => p.arxiv_id)).catch((error) => {
    ctx.logger.warn('arxiv-inspiration: markRecommended failed: %s', error?.message);
  });

  const recallStats = {
    fetched: fetched.length,
    carryover: carryover.length,
    filtered: filtered.length,
    keyword_lane: keywordLaneSize,
    semantic_lane: semanticLaneSize,
    candidates: candidates.length,
    rank_batches: batchCount,
    estimated_tokens: estimatedTokens,
    hybrid: hybridRanking && filtered.length > maxCandidates,
  };

  // 喂给启发 LLM 的是"论文预算"pushCount 内的精排头部，而推荐给用户的 maxPush 篇
  // 是它的子集——让 LLM 从更大的池里挑，而不是先砍到 maxPush。窗口再受 token 预算约束。
  const inspirationWindow = (() => {
    const cap = Math.min(ranked.length, pushCount);
    let used = 0;
    let count = 0;
    for (let i = 0; i < cap; i += 1) {
      const p = ranked[i];
      const cost = estimateTokens(`${p.title ?? ''}\n${p.abstract ?? ''}`) + 40;
      if (count > 0 && used + cost > INSPIRATION_TOKEN_BUDGET) break;
      used += cost;
      count += 1;
    }
    return count;
  })();

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
      system: inspirationSystem({ maxRecommend: maxPush }),
      user: inspirationUser({
        profile,
        interestChunks,
        researchContext,
        pushedIds,
        papers: ranked.slice(0, inspirationWindow),
        userNotes,
      }),
      signal,
      route,
    });
  } catch (error) {
    ctx.logger.warn('arxiv-inspiration: inspiration LLM failed: %s', error?.message);
    inspiration = {
      recommended: ranked.slice(0, pushLimit).map((p) => ({
        arxiv_id: p.arxiv_id,
        title: p.title,
        score: p.score,
        reason: p.brief_reason || '按综合排序得分入选（未调用 LLM 生成推荐理由）。',
        inspiration: '启发生成 LLM 不可用，本篇按精排得分入选。',
        suggested_action: '先阅读摘要，判断是否与当前研究相关。',
        needs_pdf: false,
      })),
      agent_context: `Top-ranked relevant papers: ${ranked
        .slice(0, pushLimit)
        .map((p) => `${p.title} (${p.url})`)
        .join('; ')}.`,
      skipped_summary: 'LLM 不可用，本次使用规则评分降级排序。',
    };
  }

  // On-demand PDF full-text analysis (map-reduce, never truncated).
  // Deep-read results are cached in the library (papers.jsonl pdf_analysis,
  // keyed to the paper's updated date) so a paper is only analyzed once.
  const pdfNotes = [];
  const deepReadWanted = (inspiration.recommended || []).filter((r) => r.needs_pdf);
  const deepReadTargets = deepReadWanted.slice(0, MAX_DEEP_READS);
  if (deepReadWanted.length > deepReadTargets.length) {
    ctx.logger.warn(
      'arxiv-inspiration: deep read capped at %d of %d requested papers',
      MAX_DEEP_READS,
      deepReadWanted.length,
    );
  }
  for (const rec of deepReadTargets) {
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
    .slice(0, pushLimit)
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
  // render each paper bilingually in one place. Batched by token budget, because
  // 推荐数 = 不限制 can surface dozens of papers.
  if (digestPapers.length > 0) {
    const byId = await translateInBatches(ctx, digestPapers, { signal, route });
    for (const paper of digestPapers) {
      const t = byId.get(paper.arxiv_id);
      if (t) {
        if (t.title_zh) paper.title_zh = String(t.title_zh);
        if (t.abstract_zh) paper.abstract_zh = String(t.abstract_zh);
      }
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
  // Full ranked list (no 20-paper cap): 推送数 decides how many are injected.
  const papersExtended = ranked.map((p) => ({
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
    carryover_count: carryover.length,
    // 生效的两档预算（pushCount 已被 PUSH_COUNT_MAX 钳制，maxPush 已被 pushCount 钳制）
    push_limits: { pushCount, maxPush, llm_window: inspirationWindow },
    recall: recallStats,
    recommended: digestPapers,
    papers_extended: papersExtended,
    agent_context: agentContext,
    skipped_summary: inspiration.skipped_summary ?? '',
    markdown,
    alphaxiv_note: alphaxivNote || undefined,
    pdf_skipped:
      deepReadWanted.length > deepReadTargets.length
        ? deepReadWanted.length - deepReadTargets.length
        : undefined,
    fetch_errors: fetchErrors.length ? fetchErrors : undefined,
  };
}

/**
 * Render the session-injection payload: configurable English prompt followed
 * by an English list of papers (title + abstract + link), no LLM involved.
 */
export function renderInjection(papers, pushPrompt, { date, count } = {}) {
  const all = papers || [];
  // count = 0 (or missing) means "no limit": inject the whole list.
  const requested = Number(count);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : all.length;
  const list = all.slice(0, limit);
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
