/**
 * Reusable survey pipeline: fetch → coarse filter → KB retrieval → LLM
 * ranking → inspiration → optional PDF analysis → bilingual digest render.
 * Extracted so both the agent tool and the settings-page HTTP API share it.
 */

import { coarseFilter, fetchById as arxivFetchById, fetchDay } from './arxiv.js';
import { targetDays, utc8Today } from './dates.js';
import * as kb from './kb.js';
import {
  FILTER_SYSTEM,
  RECHECK_COARSE_SYSTEM,
  recheckCoarseUser,
  inspirationSystem,
  PDF_MAP_SYSTEM,
  PDF_REDUCE_SYSTEM,
  DEEPREAD_SYNTHESIZE_SYSTEM,
  deepReadSynthesizeUser,
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

/**
 * Markdown section for the alphaXiv semantic-discovery picks (语义发现).
 * Same bilingual per-paper format as the dated digest, but its own heading:
 * these papers are relevance-ranked and deliberately OUTSIDE the weekday
 * window (user decision 2026-11-10).
 */
function discoverySection(papers) {
  const parts = [
    '## 🔍 alphaXiv 语义发现 / Semantic Discovery',
    '',
    '_alphaXiv 语义检索按相关性补充的论文，投稿时间不受本次调研的星期窗口限制。_',
    '',
  ];
  papers.forEach((p, i) => {
    parts.push(`### ${i + 1}. ${p.title}${p.title_zh ? ` / ${p.title_zh}` : ''}`);
    parts.push(`**Categories:** ${(p.categories || []).join(', ')}`);
    parts.push(`**Link:** ${p.url}`);
    if (p.published) parts.push(`**Published:** ${String(p.published).slice(0, 10)}`);
    parts.push('');
    parts.push('**Abstract / 摘要:**');
    parts.push(`> ${p.abstract}`);
    if (p.abstract_zh) parts.push(`> ${p.abstract_zh}`);
    parts.push('');
    if (p.reason) parts.push(`**推荐理由:** ${p.reason}`);
    if (p.inspiration) parts.push(`**💡 启发:** ${p.inspiration}`);
    if (p.suggested_action) parts.push(`**▶ 建议行动:** ${p.suggested_action}`);
    parts.push('');
    parts.push('---');
  });
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
    topN = 20,
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
    .slice(0, topN)
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
export async function deepRead(ctx, { paper, motivation, useAlphaxivDeepRead, signal, route }) {
  let material;
  let provenance = 'local';
  if (useAlphaxivDeepRead !== false) {
    try {
      const queries = [motivation?.reason, motivation?.inspiration]
        .filter(Boolean)
        .map((q) => String(q).slice(0, 300));
      if (queries.length === 0) queries.push(`What are the key methods and results of ${paper.title}?`);
      material = await alphaxiv.answerPdfQueries({ paper, queries }, signal);
      provenance = 'alphaxiv';
    } catch (error) {
      if (signal?.aborted) throw error;
      ctx.logger.warn('arxiv-inspiration: alphaXiv deep read failed, falling back to local PDF: %s', error?.message);
    }
  }
  if (!material) material = await analyzeFullText(ctx, { paper, signal, route });
  if (!material) return undefined;
  // Archive the raw material at full fidelity: the synthesized note below is a
  // condensation and must never be the only record of what the source said.
  await kb.writeAnalysisRaw(paper.arxiv_id, {
    title: paper.title,
    material,
    provenance,
  }).catch(() => null);
  // Both sources are raw (page XML / English bullets). Synthesize one clean
  // Chinese deep-read note; on LLM failure degrade to the raw material.
  try {
    const note = await chat(ctx, {
      system: DEEPREAD_SYNTHESIZE_SYSTEM,
      user: deepReadSynthesizeUser({ title: paper.title, motivation, material }),
      signal,
      route,
      maxTokens: 16384,
    });
    const source = provenance === 'alphaxiv' ? 'alphaXiv 页级检索' : '本地 PDF 全文解析';
    return `${String(note).trim()}\n\n- 深读来源：${source}`;
  } catch (error) {
    if (signal?.aborted) throw error;
    ctx.logger.warn('arxiv-inspiration: deep-read synthesis failed, keeping raw material: %s', error?.message);
    return provenance === 'alphaxiv' ? `[alphaXiv deep read] ${material}` : material;
  }
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
  // structurally misses. Per user decision (2026-11-10): discovery papers are
  // NOT gated by the weekday window — they form their own「语义发现」section
  // (count = 推荐数 maxPush) with the same treatment as the main picks.
  let discovered = [];
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
      const returned = await alphaxiv.discoverPapers({ keywords, question, difficulty: 3 }, signal);
      const seen = new Set(fetched.map((p) => p.arxiv_id));
      let backfilled = 0;
      for (const paper of returned) {
        if (seen.has(paper.arxiv_id)) continue;
        let candidate = {
          ...paper,
          authors: paper.authors ?? [],
          abstract: paper.abstract || '',
          updated: paper.updated ?? paper.published ?? '',
          source: 'alphaxiv',
        };
        // Discovery replies routinely omit abstract/published (only id+title).
        // Backfill from the arXiv Atom API (free, no LLM quota, capped) so
        // ranking, translation and the card have real values to work with.
        if ((!candidate.abstract || !candidate.published) && backfilled < 12) {
          const full = await arxivFetchById(candidate.arxiv_id, signal).catch(() => undefined);
          if (full) {
            candidate = {
              ...full,
              published: full.published || candidate.published,
              updated: full.updated || candidate.updated,
              source: 'alphaxiv',
            };
            backfilled++;
          }
        }
        seen.add(candidate.arxiv_id);
        discovered.push(candidate);
      }
      alphaxivNote = `alphaXiv 语义发现 ${discovered.length} 篇（返回 ${returned.length}${backfilled ? `，arXiv 摘要补全 ${backfilled}` : ''}）——单列「语义发现」区，不受星期窗口限制`;
      ctx.logger.info('arxiv-inspiration: %s', alphaxivNote);
    } catch (error) {
      if (signal?.aborted) throw error;
      alphaxivNote = `alphaXiv 发现增补不可用（已跳过）：${String(error?.message ?? error).slice(0, 120)}`;
      ctx.logger.warn('arxiv-inspiration: %s', alphaxivNote);
    }
  }

  // Library upsert (P0-1): every FRESHLY fetched paper (Atom + semantic
  // discovery) enters papers.jsonl; new papers also get queued for background
  // semantic indexing. Carry-over papers are deliberately excluded: bumping
  // their last_seen would extend their window on every run and they would
  // never age out.
  await kb.upsertPapers(discovered.length ? [...fetched, ...discovered] : fetched).catch((error) => {
    ctx.logger.warn('arxiv-inspiration: upsertPapers failed: %s', error?.message);
  });
  kb.indexPapersInBackground().catch(() => {});

  const interestChunks = await kb.searchInterest(
    `${researchContext} ${profile}`.trim() || profile,
    5,
  );

  // Carry-over (回捞): papers from an earlier survey that were never
  // recommended or pushed get a second chance instead of being lost to the
  // newest-first truncation. Per user decision (2026-11-10): NOT gated by the
  // weekday window — carry-over entries keep any submission date and are
  // labeled「↩️ 回捞」on the card via the source tag. Still bounded, and
  // subject to every other filter (pushed/negative/category/LLM ranking).
  let carryover = [];
  if (carryoverLimit > 0) {
    const rawCarryover = await kb
      .carryoverCandidates({
        days: carryoverDays,
        limit: carryoverLimit,
        // This run's OWN papers (weekday window + semantic discovery) are
        // already in the pool via their lanes; letting the carry-over lane
        // re-admit them right after the upsert would double them into the
        // main ranking with a wrong 回捞 tag.
        excludeIds: [
          ...pushedIds,
          ...negative.directIds,
          ...fetched.map((p) => p.arxiv_id),
          ...discovered.map((p) => p.arxiv_id),
        ],
        interestChunks,
      })
      .catch((error) => {
        ctx.logger.warn('arxiv-inspiration: carryover failed: %s', error?.message);
        return [];
      });
    carryover = rawCarryover.map((p) => ({ ...p, source: 'carryover' }));
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

  // Discovery lane (语义发现): ranked SEPARATELY from the weekday-window pool
  // with the same fine-ranking pass (0-40 score + brief_reason); its top picks
  // become the card's「语义发现」section instead of competing with the dated
  // recommendations.
  let discoveryRanked = [];
  if (discovered.length > 0) {
    const pushedSet = new Set(pushedIds);
    const dCandidates = discovered
      .filter((p) => !pushedSet.has(p.arxiv_id) && !negative.directIds.has(p.arxiv_id))
      .slice(0, maxCandidates);
    if (dCandidates.length > 0) {
      try {
        const dRank = await rankPapers(ctx, {
          papers: dCandidates,
          profile,
          interestChunks,
          researchContext,
          signal,
          route,
          tokenBudget: rankTokenBudget,
          abstractChars,
          topN: Math.max(maxPush, 10),
        });
        discoveryRanked = dRank.ranked;
      } catch (error) {
        if (signal?.aborted) throw error;
        ctx.logger.warn('arxiv-inspiration: discovery ranking failed: %s', error?.message);
      }
    }
  }

  // Record that these papers were offered (main lane + discovery lane), so the
  // carry-over lane will not surface them again inside its window.
  await kb.markRecommended([...ranked, ...discoveryRanked].map((p) => p.arxiv_id)).catch((error) => {
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
  // The same window helper serves the discovery lane below (cap = maxPush).
  const inspirationWindowOf = (list, cap) => {
    let used = 0;
    let count = 0;
    for (let i = 0; i < Math.min(list.length, cap); i += 1) {
      const p = list[i];
      const cost = estimateTokens(`${p.title ?? ''}\n${p.abstract ?? ''}`) + 40;
      if (count > 0 && used + cost > INSPIRATION_TOKEN_BUDGET) break;
      used += cost;
      count += 1;
    }
    return count;
  };
  const inspirationWindow = inspirationWindowOf(ranked, pushCount);

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
        lib.pdf_analysis_style === 3 &&
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
  // `source` flows through from the pool (carry-over entries are tagged).
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
        published: paper?.published ?? r.published ?? '',
        updated: paper?.updated ?? r.updated ?? '',
        source: paper?.source ?? r.source,
      };
    });

  // Discovery lane inspiration (语义发现): same Chinese reason/inspiration/
  // suggested_action treatment as the main picks (user decision A=要), one
  // extra LLM call over the top maxPush discovery papers. needs_pdf is
  // deliberately ignored here — deep reads stay a main-recommendation feature.
  let discoveryPapers = [];
  let discoveryAgentContext = '';
  let discoverySkipped = '';
  if (discoveryRanked.length > 0) {
    const dWindow = inspirationWindowOf(discoveryRanked, maxPush);
    let discoveryInspiration;
    try {
      discoveryInspiration = await chatJson(ctx, {
        system: inspirationSystem({ maxRecommend: maxPush }),
        user: inspirationUser({
          profile,
          interestChunks,
          researchContext,
          pushedIds,
          papers: discoveryRanked.slice(0, dWindow),
          userNotes,
        }),
        signal,
        route,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      ctx.logger.warn('arxiv-inspiration: discovery inspiration LLM failed: %s', error?.message);
      discoveryInspiration = {
        recommended: discoveryRanked.slice(0, maxPush).map((p) => ({
          arxiv_id: p.arxiv_id,
          title: p.title,
          score: p.score,
          reason: p.brief_reason || '按综合排序得分入选（未调用 LLM 生成推荐理由）。',
          inspiration: '启发生成 LLM 不可用，本篇按精排得分入选。',
          suggested_action: '先阅读摘要，判断是否与当前研究相关。',
          needs_pdf: false,
        })),
        agent_context: `Top-ranked semantic discovery: ${discoveryRanked
          .slice(0, maxPush)
          .map((p) => `${p.title} (${p.url})`)
          .join('; ')}.`,
        skipped_summary: '发现区启发生成 LLM 不可用，按精排得分降级。',
      };
    }
    discoveryPapers = (discoveryInspiration.recommended || [])
      .slice(0, maxPush)
      .map((r) => {
        const paper = discoveryRanked.find((p) => p.arxiv_id === r.arxiv_id);
        return {
          ...r,
          title: paper?.title ?? r.title,
          abstract: paper?.abstract ?? r.abstract ?? '',
          categories: paper?.categories ?? r.categories ?? [],
          url: paper?.url ?? `https://arxiv.org/abs/${r.arxiv_id}`,
          published: paper?.published ?? r.published ?? '',
          updated: paper?.updated ?? r.updated ?? '',
          score: paper?.score ?? r.score,
          brief_reason: paper?.brief_reason,
          source: 'alphaxiv',
        };
      });
    discoveryAgentContext = String(discoveryInspiration.agent_context || '');
    discoverySkipped = discoveryInspiration.skipped_summary ?? '';
  }

  if (discoveryAgentContext) {
    agentContext += `\n\nSemantic discovery via alphaXiv (relevance-ranked, OUTSIDE the weekday window; supplementary to the dated list above):\n${discoveryAgentContext}`;
  }

  const date = utc8Today();

  // Per-paper Simplified-Chinese translation (title + abstract) so the card can
  // render each paper bilingually in one place. Batched by token budget, because
  // 推荐数 = 不限制 can surface dozens of papers. Discovery papers ride the
  // same batched call (语义发现 entries are user-facing too).
  const toTranslate = [...digestPapers, ...discoveryPapers];
  if (toTranslate.length > 0) {
    const zhById = await translateInBatches(ctx, toTranslate, { signal, route });
    for (const paper of toTranslate) {
      const t = zhById.get(paper.arxiv_id);
      if (t) {
        if (t.title_zh) paper.title_zh = String(t.title_zh);
        if (t.abstract_zh) paper.abstract_zh = String(t.abstract_zh);
      }
    }
  }

  // Deterministic bilingual markdown kept for the record and the digest push
  // API. Discovery papers form their own section below the dated picks.
  let markdown = digestPapers.length > 0 ? fallbackDigest(date, digestPapers) : '';
  if (discoveryPapers.length > 0) {
    const section = discoverySection(discoveryPapers);
    markdown = markdown
      ? `${markdown}\n\n${section}`
      : `# arXiv 研究启发推荐 / arXiv Research Digest — ${date}\n\n${section}`;
  }

  // Library enrichment upsert: LLM scores, zh translations, and cached PDF
  // analyses flow back into papers.jsonl (main lane + discovery lane).
  {
    const zhById = new Map(
      [...digestPapers, ...discoveryPapers].map((d) => [d.arxiv_id, d]),
    );
    const enrichments = new Map();
    for (const p of [...ranked, ...discoveryRanked]) {
      const zh = zhById.get(p.arxiv_id);
      enrichments.set(p.arxiv_id, {
        score: p.score,
        title_zh: zh?.title_zh,
        abstract_zh: zh?.abstract_zh,
        pdf_analysis: p.pdf_analysis_cached ?? p.pdf_analysis,
        // 3 = faithful full Chinese translation of the raw material (regenerates older styles)
        pdf_analysis_style: p.pdf_analysis_cached ? 3 : undefined,
        pdf_analysis_summary: p.pdf_analysis_summary ?? undefined,
      });
    }
    await kb.upsertPapers([...ranked, ...discoveryRanked], { enrichments }).catch((error) => {
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
    discovery: discoveryPapers,
    discovery_count: discovered.length,
    papers_extended: papersExtended,
    agent_context: agentContext,
    skipped_summary: [inspiration.skipped_summary, discoverySkipped].filter(Boolean).join('；'),
    markdown,
    alphaxiv_note: alphaxivNote || undefined,
    pdf_skipped:
      deepReadWanted.length > deepReadTargets.length
        ? deepReadWanted.length - deepReadTargets.length
        : undefined,
    fetch_errors: fetchErrors.length ? fetchErrors : undefined,
  };
}

// ---------------------------------------------------------------------------
// Library recheck (库内重评): re-evaluate papers ALREADY in papers.jsonl
// against the CURRENT profile — papers once filtered out may be relevant
// again after the profile evolves, and surveys can only see the last 7 days.
// Funnel: cheap 0-10 coarse pass over every candidate → fine ranking pass
// over the top survivors → inspiration deep treatment for the top picks.
// Outputs three tiers: recommended (full treatment + translation),
// worth_a_look (one-line reason, no translation), and recheck_score written
// back into papers.jsonl for EVERY candidate (library sorts benefit).
// ---------------------------------------------------------------------------
const RECHECK_COARSE_BATCH = 50; // papers per coarse triage call (title + 300-char slice)
const RECHECK_COARSE_CHARS = 300;
const RECHECK_COARSE_FLOOR = 4; // coarse score needed to reach the fine pass
const RECHECK_FINE_LIMIT = 80; // cap on papers entering the fine ranking pass
const RECHECK_WORTH_LOOK = 30; // worth-a-look tier size below the top picks

/** Deterministic keyword-overlap fallback for the coarse pass (0-10). */
function coarseRuleScore(paper, profileText, researchContext) {
  const tokens = new Set(
    String(`${profileText} ${researchContext || ''}`)
      .toLowerCase()
      .split(/[^a-z0-9+#.]+/)
      .filter((t) => t.length > 3),
  );
  const hay = `${paper.title ?? ''} ${paper.abstract ?? ''}`.toLowerCase();
  let hits = 0;
  for (const token of tokens) if (hay.includes(token)) hits++;
  return Math.min(10, hits);
}

/**
 * Run one library recheck. `params` is merged with plugin config:
 * { includeRecommended, includePushed, fullRescan, since, until, maxPush,
 *   rankTokenBudget, abstractChars, researchContext }.
 * `onProgress` receives { stage: 'coarse'|'fine'|'translate', done, total }
 * so the caller can persist progress into the survey record.
 */
export async function runRecheck(ctx, params, { signal, route, onProgress } = {}) {
  const startedAt = Date.now();
  const { maxPush } = resolvePaperBudget(params);
  const pushLimit = Math.max(1, Math.min(10, maxPush || 5));
  const researchContext = typeof params.researchContext === 'string' ? params.researchContext : '';
  const rankTokenBudget = Math.max(
    4000,
    Math.min(60000, Number(params.rankTokenBudget) || DEFAULT_RANK_TOKEN_BUDGET),
  );
  const abstractChars = Math.max(
    400,
    Math.min(4000, Number(params.abstractChars) || DEFAULT_ABSTRACT_CHARS),
  );

  await kb.initIfMissing().catch(() => {});
  const [profile, pushedIds] = await Promise.all([kb.getProfile(), kb.getPushedIds()]);
  const interestChunks = await kb.searchInterest(
    `${researchContext} ${profile}`.trim() || profile,
    5,
  );

  // 1. Candidate pool (watermark + standing exclusions live in kb).
  const candidates = await kb.recheckCandidates({
    includeRecommended: params.includeRecommended === true,
    includePushed: params.includePushed === true,
    fullRescan: params.fullRescan === true,
    since: typeof params.since === 'string' ? params.since : '',
    until: typeof params.until === 'string' ? params.until : '',
  });
  if (candidates.length === 0) {
    return {
      error:
        '论文库中没有待重评的论文：全部已重评过（水位线）或被默认排除（已推荐/已推送/不感兴趣反馈）。可开启「全量重扫」或放宽包含范围。',
    };
  }

  // 2. Coarse pass: EVERY candidate gets a cheap 0-10 score, batched and
  // parallel. Batch failure degrades to deterministic keyword scoring (never
  // to zeros — a total LLM outage must not poison the watermark).
  const batches = [];
  for (let i = 0; i < candidates.length; i += RECHECK_COARSE_BATCH) {
    batches.push(candidates.slice(i, i + RECHECK_COARSE_BATCH));
  }
  onProgress?.({ stage: 'coarse', done: 0, total: batches.length });
  let coarseDone = 0;
  const coarseScores = new Map();
  const coarseResults = await Promise.all(
    batches.map(async (batch) => {
      let rows;
      try {
        const reply = await chatJson(ctx, {
          system: RECHECK_COARSE_SYSTEM,
          user: recheckCoarseUser({
            profile,
            interestChunks,
            researchContext,
            papers: batch,
            abstractChars: RECHECK_COARSE_CHARS,
          }),
          signal,
          route,
        });
        rows = reply.scores || [];
      } catch (error) {
        if (signal?.aborted) throw error;
        ctx.logger.warn(
          'arxiv-inspiration: recheck coarse batch failed, keyword fallback: %s',
          error?.message,
        );
        rows = [];
      }
      const scored = new Map(rows.map((r) => [r.arxiv_id, r]));
      const result = batch.map((p) => ({
        arxiv_id: p.arxiv_id,
        score: scored.has(p.arxiv_id)
          ? Number(scored.get(p.arxiv_id).score) || 0
          : coarseRuleScore(p, profile, researchContext),
      }));
      coarseDone++;
      onProgress?.({ stage: 'coarse', done: coarseDone, total: batches.length });
      return result;
    }),
  );
  for (const rows of coarseResults) {
    for (const r of rows) coarseScores.set(r.arxiv_id, r.score);
  }
  // Watermark: every evaluated candidate is marked, so the default next run
  // only sees papers never rechecked before.
  await kb.markRechecked([...coarseScores].map(([arxiv_id, score]) => ({ arxiv_id, score }))).catch(
    (error) => {
      ctx.logger.warn('arxiv-inspiration: markRechecked failed: %s', error?.message);
    },
  );

  // 3. Fine pass: top coarse survivors through the SAME ranking machinery a
  // survey uses (token-budgeted batches, 0-40 scores + brief reasons).
  const survivors = candidates
    .filter((p) => (coarseScores.get(p.arxiv_id) ?? 0) >= RECHECK_COARSE_FLOOR)
    .sort((a, b) => (coarseScores.get(b.arxiv_id) ?? 0) - (coarseScores.get(a.arxiv_id) ?? 0))
    .slice(0, RECHECK_FINE_LIMIT);
  onProgress?.({ stage: 'fine', done: 0, total: 1 });
  let ranked = [];
  if (survivors.length > 0) {
    const { ranked: fineRanked } = await rankPapers(ctx, {
      papers: survivors,
      profile,
      interestChunks,
      researchContext,
      signal,
      route,
      tokenBudget: rankTokenBudget,
      abstractChars,
      topN: pushLimit + RECHECK_WORTH_LOOK,
    });
    ranked = fineRanked;
  }
  onProgress?.({ stage: 'fine', done: 1, total: 1 });

  // 4. Top picks → inspiration deep treatment (Chinese reason/inspiration/
  // action). needs_pdf is ignored: recheck never triggers deep reads — the
  // library's cached notes and the 论文库 deep-read flow cover that.
  const topPicks = ranked.slice(0, pushLimit);
  let inspiration = null;
  if (topPicks.length > 0) {
    const userNotes = await kb.notesForPrompt(topPicks.map((p) => p.arxiv_id)).catch(() => ({
      onCandidates: [],
      recentUser: [],
    }));
    try {
      inspiration = await chatJson(ctx, {
        system: inspirationSystem({ maxRecommend: pushLimit }),
        user: inspirationUser({
          profile,
          interestChunks,
          researchContext,
          pushedIds,
          papers: topPicks,
          userNotes,
        }),
        signal,
        route,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      ctx.logger.warn('arxiv-inspiration: recheck inspiration LLM failed: %s', error?.message);
    }
  }
  const recommended = topPicks.map((p, i) => {
    const r = (inspiration?.recommended || []).find((x) => x.arxiv_id === p.arxiv_id);
    return {
      arxiv_id: p.arxiv_id,
      title: p.title,
      title_zh: p.title_zh || undefined,
      abstract: p.abstract ?? '',
      abstract_zh: p.abstract_zh || undefined,
      categories: p.categories ?? [],
      url: p.url,
      score: p.score,
      coarse_score: coarseScores.get(p.arxiv_id) ?? null,
      reason:
        r?.reason
        || p.brief_reason
        || (i === 0 ? '按重评综合得分入选。' : `按重评综合得分入选（第 ${i + 1} 名）。`),
      inspiration: r?.inspiration || '（启发生成不可用，按精排得分入选）',
      suggested_action: r?.suggested_action || '先阅读摘要，判断是否与当前研究相关。',
    };
  });

  // 5. Worth-a-look tier: fine-ranked papers right below the picks. If the
  // fine pass produced nothing (total LLM failure), fall back to coarse order.
  let worthLook = ranked
    .slice(pushLimit, pushLimit + RECHECK_WORTH_LOOK)
    .map((p) => ({
      arxiv_id: p.arxiv_id,
      title: p.title,
      url: p.url,
      coarse_score: coarseScores.get(p.arxiv_id) ?? null,
      score: p.score,
      reason: p.brief_reason || '精排通过，未生成详细理由。',
    }));
  if (worthLook.length === 0 && survivors.length > 0) {
    worthLook = survivors.slice(pushLimit, pushLimit + RECHECK_WORTH_LOOK).map((p) => ({
      arxiv_id: p.arxiv_id,
      title: p.title,
      url: p.url,
      coarse_score: coarseScores.get(p.arxiv_id) ?? null,
      score: null,
      reason: '精排不可用，按粗筛分入选。',
    }));
  }

  // 6. Translate the recommended tier only (worth-a-look stays English).
  onProgress?.({ stage: 'translate', done: 0, total: 1 });
  if (recommended.length > 0) {
    const byId = await translateInBatches(ctx, recommended, { signal, route });
    for (const paper of recommended) {
      const t = byId.get(paper.arxiv_id);
      if (t) {
        if (t.title_zh) paper.title_zh = String(t.title_zh);
        if (t.abstract_zh) paper.abstract_zh = String(t.abstract_zh);
      }
    }
  }
  onProgress?.({ stage: 'translate', done: 1, total: 1 });

  // 7. Record + library enrichment: recommended papers become 已推荐; fine
  // scores + zh translations flow back through the same upsert as surveys.
  await kb.markRecommended(recommended.map((p) => p.arxiv_id)).catch((error) => {
    ctx.logger.warn('arxiv-inspiration: markRecommended failed: %s', error?.message);
  });
  if (ranked.length > 0) {
    const enrichments = new Map(
      ranked.map((p) => [
        p.arxiv_id,
        {
          score: p.score,
          title_zh: recommended.find((d) => d.arxiv_id === p.arxiv_id)?.title_zh,
          abstract_zh: recommended.find((d) => d.arxiv_id === p.arxiv_id)?.abstract_zh,
        },
      ]),
    );
    await kb.upsertPapers(ranked, { enrichments }).catch((error) => {
      ctx.logger.warn('arxiv-inspiration: recheck enrich upsert failed: %s', error?.message);
    });
  }

  const date = utc8Today();
  // Deterministic bilingual digest: reuse the survey body under a recheck
  // header (its first header line is replaced).
  const base = recommended.length > 0 ? fallbackDigest(date, recommended) : '';
  const markdown = base
    ? `# ♻️ 论文库重评推荐 / Library Recheck Digest — ${date}\n\n_按当前画像重评论文库 ${candidates.length} 篇；粗筛存活 ${survivors.length} 篇，另有 ${worthLook.length} 篇值得一看（见设置页卡片）。_\n\n${base.replace(/^#[^\n]*\n/, '')}`
    : '';

  return {
    type: 'recheck',
    date_utc8: date,
    scope: {
      include_recommended: params.includeRecommended === true,
      include_pushed: params.includePushed === true,
      full_rescan: params.fullRescan === true,
      since: params.since || undefined,
      until: params.until || undefined,
    },
    candidate_count: candidates.length,
    coarse_batches: batches.length,
    fine_pool: survivors.length,
    recommended_count: recommended.length,
    worth_look_count: worthLook.length,
    recommended,
    worth_a_look: worthLook,
    skipped_summary: inspiration?.skipped_summary ?? '',
    agent_context: inspiration?.agent_context ?? '',
    markdown,
    duration_ms: Date.now() - startedAt,
  };
}

/**
 * Render the push-collection injection: a curated pool accumulated across
 * surveys plus manual picks, delivered in one shot. Same shape as
 * renderInjection plus the per-paper collection reason (often Chinese).
 */
export function renderCollectionInjection(papers, { note = '', abstractChars = 1000 } = {}) {
  const list = (papers || []).filter(Boolean);
  const lines = [];
  if (note) lines.push(String(note), '');
  lines.push(
    `Curated arXiv paper collection (${list.length} papers, accumulated by the user across surveys and manual picks):`,
    '',
    'Reading hierarchy for cost control: skim the abstracts first; open a paper\'s deep-read',
    'note (file path, Chinese digest) only for the papers you actually need in depth; open',
    'the full text (file path) last, only when the note is insufficient. Read files by their',
    'absolute paths. Not every paper deserves the deepest level.',
    '',
  );
  list.forEach((p, i) => {
    const abs = String(p.abstract ?? '');
    const trimmed = abs.length > abstractChars ? `${abs.slice(0, abstractChars)}…` : abs;
    lines.push(`## ${i + 1}. ${p.title}`);
    lines.push(`- arXiv: ${p.arxiv_id} | Categories: ${(p.categories || []).join(', ')}`);
    lines.push(`- Link: ${p.url || `https://arxiv.org/abs/${p.arxiv_id}`}`);
    if (p.note) lines.push(`- Why collected: ${p.note}`);
    if (trimmed) lines.push(`- Abstract: ${trimmed}`);
    if (p.analysis_path) lines.push(`- Deep-read note (start here for depth): ${p.analysis_path}`);
    if (p.agentero_path) lines.push(`- paper-reader deep-dive (external, full figures): ${p.agentero_path}`);
    if (p.fulltext_path) lines.push(`- Full text: ${p.fulltext_path}`);
    lines.push('');
  });
  return lines.join('\n').trim();
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
    if (p.agentero_path) lines.push(`- paper-reader deep-dive (external, full figures): ${p.agentero_path}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

/**
 * Render the semantic-discovery block appended to an agent-mode injection.
 * English (agent channel), same shape as renderInjection's list but with an
 * explicit "outside the weekday window" framing and the submission date.
 */
export function renderDiscoveryInjection(papers) {
  const list = papers || [];
  if (list.length === 0) return '';
  const lines = [
    'Semantic discovery via alphaXiv (relevance-ranked, OUTSIDE the weekday window above — supplementary picks, not dated):',
    '',
  ];
  list.forEach((p, i) => {
    lines.push(`## D${i + 1}. ${p.title}`);
    lines.push(`- arXiv: ${p.arxiv_id} | Categories: ${(p.categories || []).join(', ')}`);
    lines.push(`- Link: ${p.url}`);
    lines.push(`- Published: ${String(p.published ?? 'unknown').slice(0, 10)}`);
    lines.push(`- Abstract: ${p.abstract}`);
    if (p.agentero_path) lines.push(`- paper-reader deep-dive (external, full figures): ${p.agentero_path}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}
