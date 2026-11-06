/**
 * Candidate recall + hybrid fusion + token-aware batching.
 *
 * The survey pipeline fetches far more papers than the ranking LLM can
 * affordably read (a busy week returns 800+). Instead of keeping only the most
 * recent N, we run two cheap recall lanes over the whole pool and fuse their
 * RANKINGS with Reciprocal Rank Fusion (RRF):
 *
 *   lane A — weighted keyword/tag overlap (free, always available)
 *   lane B — local embedding similarity via fastembed (free, may be missing)
 *
 * RRF is rank-based on purpose: the two lanes produce scores on incomparable
 * scales, so only their orderings are combined. A missing lane simply does not
 * vote, which is the whole fallback story (no embeddings → keyword-only recall).
 */

const RRF_K = 60; // standard RRF damping; both lanes weight 1.0

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'into',
  'using', 'used', 'via', 'based', 'toward', 'towards', 'over', 'under', 'between',
  'their', 'there', 'which', 'while', 'when', 'where', 'what', 'have', 'has', 'had',
  'are', 'was', 'were', 'been', 'being', 'can', 'could', 'may', 'might', 'should',
  'would', 'will', 'not', 'but', 'also', 'more', 'most', 'less', 'such', 'than',
  'study', 'studies', 'approach', 'approaches', 'method', 'methods', 'model',
  'models', 'analysis', 'paper', 'papers', 'result', 'results', 'work', 'works',
  'new', 'novel', 'propose', 'proposed', 'show', 'shows', 'shown', 'we', 'our',
  'they', 'them', 'its', 'about', 'however', 'therefore', 'thus', 'here',
]);

/** Lowercase word tokens that survive stopwording (keeps 21cm, c++, x-ray). */
export function terms(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9+#.\-]+/)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Build the weighted keyword set from the KB: interest tags are strong phrases,
 * interest/profile/context words are weak terms. Weights only order the
 * keyword lane; the ranking LLM still makes every relevance judgement.
 */
export function buildKeywordSpec({ profile, interestChunks, researchContext } = {}) {
  const phrases = new Map(); // lowercased phrase → weight
  const words = new Map(); // token → weight
  const bump = (map, key, weight) => {
    if (!key) return;
    map.set(key, Math.max(map.get(key) ?? 0, weight));
  };

  for (const chunk of interestChunks ?? []) {
    const chunkWeight = Math.max(1, Number(chunk.weight) || 1);
    for (const tag of chunk.tags ?? []) {
      const phrase = String(tag).toLowerCase().trim();
      if (phrase.length > 2) bump(phrases, phrase, chunkWeight);
    }
    for (const token of terms(chunk.text)) bump(words, token, 0.5 * chunkWeight);
  }
  for (const token of terms(profile)) bump(words, token, 0.35);
  for (const token of terms(researchContext)) bump(words, token, 0.6);

  return { phrases, words };
}

/**
 * Weighted keyword score per paper. A title hit counts 2× an abstract hit: the
 * title is the author's own framing of the contribution.
 * Returns ids in descending score order (papers scoring 0 are omitted).
 */
export function keywordRank(papers, spec) {
  if (!spec || (spec.phrases.size === 0 && spec.words.size === 0)) return [];
  const scored = [];
  for (const paper of papers) {
    const title = String(paper.title ?? '').toLowerCase();
    const abstract = String(paper.abstract ?? '').toLowerCase();
    if (!title && !abstract) continue;
    let score = 0;
    for (const [phrase, weight] of spec.phrases) {
      if (title.includes(phrase)) score += 2 * weight;
      else if (abstract.includes(phrase)) score += weight;
    }
    if (spec.words.size > 0) {
      const titleSet = new Set(terms(title));
      const abstractSet = new Set(terms(abstract));
      for (const [token, weight] of spec.words) {
        if (titleSet.has(token)) score += 2 * weight;
        else if (abstractSet.has(token)) score += weight;
      }
    }
    if (score > 0) scored.push({ id: paper.arxiv_id, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.id);
}

/** Semantic lane: ids in descending cosine order (caller supplies scores). */
export function semanticRank(papers, scores) {
  return papers
    .map((paper, i) => ({ id: paper.arxiv_id, score: Number(scores?.[i]) || 0 }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.id);
}

/**
 * Reciprocal Rank Fusion over ordered id lists. Lane contributions are
 * 1 / (K + rank); a paper absent from a lane gets no vote from it.
 */
export function rrfFuse(lanes, { k = RRF_K } = {}) {
  const fused = new Map();
  for (const lane of lanes) {
    if (!lane) continue;
    lane.forEach((id, index) => {
      if (!id) return;
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Cheap token estimate (~3.5 chars/token for English prose) for budgeting. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 3.5);
}

/**
 * Pack papers into LLM ranking batches under a TOKEN budget instead of a fixed
 * paper count: a batch of short abstracts can hold more papers, a batch of long
 * ones fewer, and the per-call prompt stays bounded either way.
 *
 * Abstracts are cut to `abstractChars` by default (wider than the old blind
 * 800-char slice, still bounded); a single paper that would blow the budget is
 * truncated further so the batch always has at least one member.
 */
export function packBatches(papers, { tokenBudget = 18000, abstractChars = 1600 } = {}) {
  const batches = [];
  let current = [];
  let currentTokens = 0;
  for (const paper of papers) {
    let abstract = String(paper.abstract ?? '').slice(0, abstractChars);
    const baseCost = () =>
      estimateTokens(paper.title) + estimateTokens(abstract) +
      estimateTokens((paper.categories ?? []).join(' ')) + 12;
    let cost = baseCost();
    if (cost > tokenBudget) {
      const room = Math.max(200, Math.floor((tokenBudget - 80) * 3.5));
      abstract = abstract.slice(0, room);
      cost = baseCost();
    }
    if (current.length > 0 && currentTokens + cost > tokenBudget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push({ ...paper, abstract });
    currentTokens += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
