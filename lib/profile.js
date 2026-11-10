/**
 * Profile revision drafting (P2-6): one shared generator used by the settings
 * page (server.js) and the agent tool (plugin.js). Drafts are staged, never
 * auto-applied — profile.md changes only through explicit adoption.
 */

import * as kb from './kb.js';
import { EVOLVE_PROFILE_SYSTEM, chatJson, evolveProfileUser } from './llm.js';

function aggregateFeedback(feedbackRows, papersById) {
  const latest = new Map();
  for (const row of feedbackRows) latest.set(row.arxiv_id, row.feedback ?? row);
  const interested = [];
  const notInterested = [];
  for (const [id, verdict] of latest) {
    const paper = papersById.get(id);
    const entry = {
      arxiv_id: id,
      title: paper?.title ?? '(title unknown)',
      categories: paper?.categories ?? [],
    };
    if (verdict === 'interested') interested.push(entry);
    else if (verdict === 'not_interested') notInterested.push(entry);
  }
  return { interested, not_interested: notInterested };
}

/** Generate a profile revision draft. Returns {profile_draft_md, changelog}. */
export async function draftProfileRevision(ctx, { route, signal } = {}) {
  const [profile, interests, feedbackRows, papers] = await Promise.all([
    kb.getProfile(),
    kb.listInterests(),
    kb.readFeedback(),
    kb.listPapers(),
  ]);
  const papersById = new Map(papers.map((p) => [p.arxiv_id, p]));
  const feedback = aggregateFeedback(feedbackRows, papersById);
  const topPapers = papers
    .map((p) => ({ title: p.title, categories: p.categories, best: Math.max(0, ...(p.scores ?? []).map((s) => s.total ?? 0)) }))
    .filter((p) => p.best > 0)
    .sort((a, b) => b.best - a.best)
    .slice(0, 10);
  const reply = await chatJson(ctx, {
    system: EVOLVE_PROFILE_SYSTEM,
    user: evolveProfileUser({ profile, interests, feedback, topPapers }),
    signal,
    route,
  });
  if (!reply?.profile_draft_md) throw new Error('profile draft LLM reply missing profile_draft_md');
  return {
    profile_draft_md: String(reply.profile_draft_md),
    changelog: String(reply.changelog ?? ''),
    generated_at: new Date().toISOString(),
    evidence: { interested: feedback.interested.length, not_interested: feedback.not_interested.length },
  };
}
