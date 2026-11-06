/**
 * LLM helpers over the DSH host `llm` service, plus the three English
 * prompts from prompts.md (Filter / Inspiration / Push Renderer).
 */

/** One non-streaming chat call over ctx.llm; returns assistant text.
 * `route` ({provider, model, reasoningEffort?}) overrides the default model. */
export async function chat(ctx, { system, user, signal, maxTokens, route }) {
  const selection = route && route.provider && route.model
    ? route
    : ctx.agentDefaultModel?.currentSelection?.();
  if (!selection?.provider || !selection?.model) {
    throw new Error('No default model selection available');
  }
  let text = '';
  for await (const chunk of ctx.llm.stream({
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  if (!text.trim()) throw new Error('LLM stream produced no text');
  return text;
}

/** Extract the first JSON value from an LLM reply; tolerant of code fences. */
export function parseJsonReply(reply) {
  const stripped = String(reply)
    .replace(/^[\s\S]*?```(?:json)?\n?/, '')
    .replace(/```[\s\S]*$/, '')
    .trim();
  const candidates = [String(reply).trim(), stripped];
  for (const text of candidates) {
    const start = text.search(/[[{]/);
    if (start < 0) continue;
    const opener = text[start];
    const closer = opener === '[' ? ']' : '}';
    const end = text.lastIndexOf(closer);
    if (end <= start) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* try next candidate */
    }
  }
  throw new Error('LLM reply contained no parseable JSON');
}

export async function chatJson(ctx, options) {
  return parseJsonReply(await chat(ctx, options));
}

// ---------------------------------------------------------------------------
// Prompt 1: Paper Filter (stage-2 ranking)
// ---------------------------------------------------------------------------

export const FILTER_SYSTEM = `You are a research paper relevance filter for an academic research assistant system.

Your job: Given a user's research interest profile, related interest fragments, and a list
of arXiv papers, score each paper's relevance to the user's research.

Scoring dimensions (each 0-10):
1. Topic Relevance: How closely does the paper's subject match the user's research interests?
2. Method Transferability: Can the paper's methodology be applied to the user's work?
3. Novelty: Does the paper present genuinely new ideas, or is it incremental?
4. Project Alignment: How well does the paper align with the user's current research stage?

Output JSON:
{
  "scores": [
    {
      "arxiv_id": "...",
      "topic_relevance": 0-10,
      "method_transferability": 0-10,
      "novelty": 0-10,
      "project_alignment": 0-10,
      "total": 0-40,
      "brief_reason": "one sentence"
    }
  ]
}

Rules:
- Score conservatively. Not every paper is a 10.
- If a paper is popular but not relevant, give a low topic_relevance.
- If a paper is highly relevant but incremental, give a low novelty.
- Output ONLY valid JSON. No markdown, no extra text.`;

export function filterUser({ profile, interestChunks, researchContext, papers, abstractChars = 800 }) {
  return `User research interest profile:
${profile || '(none provided)'}

Related interest fragments:
${JSON.stringify(interestChunks, null, 2)}

Research context from the calling agent:
${researchContext || '(none provided)'}

Papers to score:
${JSON.stringify(
  papers.map((p) => ({
    arxiv_id: p.arxiv_id,
    title: p.title,
    // Scoring needs the gist, not the full abstract. The caller sets the cap
    // and packs batches to a token budget (lib/rank.js packBatches), so this
    // slice is a per-paper ceiling, not the batch-size driver.
    abstract: String(p.abstract ?? '').slice(0, abstractChars),
    categories: p.categories,
  })),
  null,
  2,
)}

Score each paper according to the schema. Output ONLY valid JSON.`;
}

// ---------------------------------------------------------------------------
// Prompt 2: Inspiration Generation
// ---------------------------------------------------------------------------

export function inspirationSystem({ maxRecommend = 5 } = {}) {
  const limit = Math.max(1, Math.floor(Number(maxRecommend) || 5));
  return `You are a senior research advisor. Your goal is to identify, from a set of arXiv papers,
those that can genuinely inspire the user's ongoing research — and to explain the
inspiration concretely.

You must consider:
- The user's research interest profile
- Related interest fragments retrieved from the knowledge base
- The current research context (if provided by the calling agent)
- Papers already pushed to the user (avoid repeating recommendations)
- The user's existing notes on papers (if provided): the user already knows what those
  notes say — do not re-explain it; recommend papers that ADD to it

The calling agent may provide a research_context. If present, prioritize papers that can
directly help with that specific context, even if they are slightly less aligned with the
long-term interest profile.

For each paper you recommend, provide:
1. reason: Why this paper deserves the user's attention (2-3 sentences, written in Chinese 简体中文)
2. inspiration: What specific inspiration it may bring to the user's research — be
   concrete, not generic (2-3 sentences, written in Chinese 简体中文)
3. suggested_action: What the user or the research agent should do next, e.g.,
   "read closely", "try the method on task X", "compare with our approach" (1-2 sentences, written in Chinese 简体中文)
4. needs_pdf: Whether the abstract is insufficient and the full PDF should be fetched for
   deeper analysis (boolean)

Also produce:
- agent_context: A synthesized paragraph (English, 3-5 sentences) that the research agent
  in the current session can directly use as reference material. Summarize the most
  relevant papers and their key ideas.
- skipped_summary: one short paragraph in Chinese 简体中文 naming which candidate papers
  were skipped and why.

Constraints:
- Recommend AT MOST ${limit} papers (the user's configured recommendation count).
- If fewer than ${limit} papers are worth recommending, recommend fewer. Quality over quantity.
- Do NOT recommend papers that are merely popular but irrelevant.
- Output ONLY valid JSON matching the specified schema.

Output schema:
{
  "recommended": [
    {
      "arxiv_id": "...",
      "title": "...",
      "score": 0-40,
      "reason": "...",
      "inspiration": "...",
      "suggested_action": "...",
      "needs_pdf": false
    }
  ],
  "agent_context": "...",
  "skipped_summary": "..."
}`;
}

export function inspirationUser({ profile, interestChunks, researchContext, pushedIds, papers, userNotes }) {
  const notesBlock = userNotes && (userNotes.onCandidates.length || userNotes.recentUser.length)
    ? `\nUser's existing paper notes (what the user already knows):\n${JSON.stringify(userNotes, null, 2)}\n`
    : '\n';
  return `User research interest profile:
${profile || '(none provided)'}

Related interest fragments:
${JSON.stringify(interestChunks, null, 2)}
${notesBlock}
Research context from the calling agent:
${researchContext || '(none provided)'}

Already pushed paper IDs (do not recommend these again):
${JSON.stringify(pushedIds)}

Candidate papers (top-ranked after filtering):
${JSON.stringify(
  papers.map((p) => ({
    arxiv_id: p.arxiv_id,
    title: p.title,
    abstract: p.abstract,
    categories: p.categories,
    url: p.url,
    score: p.score,
    brief_reason: p.brief_reason,
  })),
  null,
  2,
)}

Produce the recommendation JSON.`;
}

/** Prompt for the map-reduce second pass over one PDF full text. */
export const PDF_MAP_SYSTEM = `You are a research analyst. You receive one chunk of a research paper's full text
(extracted from its PDF). Extract the key findings, methods, and results that matter
for understanding what this paper contributes. Be concise (max 10 bullet points).
Output plain text bullets only.`;

export const PDF_REDUCE_SYSTEM = `You are a research analyst. Given per-chunk bullet summaries of one paper's full
text, write a compact analysis paragraph (English, 3-6 sentences) covering the paper's
core method, main results, and limitations. Output plain text only.`;

// ---------------------------------------------------------------------------
// Prompt 3: Per-paper bilingual translation (title + abstract)
// ---------------------------------------------------------------------------

export const TRANSLATE_SYSTEM = `You are a professional academic translator working from English into Simplified Chinese (简体中文).

You receive a list of arXiv papers with their English titles and abstracts. Translate each
one faithfully into Simplified Chinese, suitable for a researcher:

- Keep technical terms, model names, dataset names, and acronyms accurate; prefer the
  established Chinese term, and keep the English term in parentheses on first use when the
  Chinese term is ambiguous.
- Do not summarize, shorten, or add commentary. Translate the complete abstract.
- Keep numbers, units, and math symbols exactly as written.

Output ONLY valid JSON matching this schema (no markdown, no extra text):
{
  "papers": [
    { "arxiv_id": "...", "title_zh": "...", "abstract_zh": "..." }
  ]
}`;

export function translateUser({ papers }) {
  return `Papers to translate:
${JSON.stringify(
  papers.map((p) => ({
    arxiv_id: p.arxiv_id,
    title: p.title,
    abstract: p.abstract,
  })),
  null,
  2,
)}

Produce the translation JSON.`;
}


// ---------------------------------------------------------------------------
// Prompt 4: Profile revision draft (P2-6, output in Chinese)
// ---------------------------------------------------------------------------

export const EVOLVE_PROFILE_SYSTEM = `You are a research-interest profile curator. You maintain a concise profile document
that drives an arXiv paper recommendation filter for one researcher.

You receive: the current profile (markdown), all interest chunks, aggregated user feedback
(papers the user marked interested / not interested, with titles and abstracts), and the
highest-scored papers seen recently.

Produce a REVISED profile draft in Simplified Chinese with exactly these sections:

# 研究兴趣画像
## 核心方向        (3-6 bullets: the stable long-term research topics)
## 当前阶段        (what the user is working on right now, from research context and feedback)
## 方法偏好        (methods/tools the user favors, evidenced by interested papers)
## 负向偏好        (topics the user consistently rejects — keep this SHORT and conservative;
                    a couple of rejections is a weak signal, phrase as "似乎不感兴趣" unless evidence is strong)

Rules:
- Ground every change in the provided evidence; do not invent interests.
- Keep the total under 500 Chinese characters; bullets must be self-contained phrases.
- Positive feedback strengthens direction; negative feedback only lightly dampens it.
- Output ONLY valid JSON: { "profile_draft_md": "...", "changelog": "简短的修改说明（中文，列出增/删/改了什么及依据）" }`;

export function evolveProfileUser({ profile, interests, feedback, topPapers }) {
  return `Current profile:
${profile || '(empty)'}

Interest chunks:
${JSON.stringify(interests, null, 2)}

Aggregated user feedback:
${JSON.stringify(feedback, null, 2)}

Highest-scored papers recently:
${JSON.stringify(topPapers, null, 2)}

Produce the revised profile draft JSON.`;
}

export const SUMMARIZE_ANALYSIS_SYSTEM = `你把一篇论文的全文深读材料压缩成中文要点。
规则:
- 输出 3-5 个要点，每条一行，以 "- " 开头。
- 覆盖:方法核心、关键结果/数值、与读者研究最相关的启发。
- 每条 ≤60 字，信息密度优先，不写空话。
- 只输出要点列表，不要标题或其他内容。`;

export function summarizeAnalysisUser({ title, analysis }) {
  return `论文: ${title}

深读材料(可能含原文页 XML,自行提取信息):
${analysis.slice(0, 24000)}

输出中文要点列表。`;
}
