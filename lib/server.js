/**
 * Same-origin HTTP API for the settings page, registered on the host
 * webServer under /arxiv-inspiration/api/*. The web UI fetches these with
 * relative URLs; the server binds loopback by default.
 */

import { randomUUID } from 'node:crypto';

import * as kb from './kb.js';
import { fetchById } from './arxiv.js';
import { draftProfileRevision } from './profile.js';
import { renderInjection, runSurvey } from './survey.js';
import {
  createSurveyRecord,
  getSurvey,
  listSurveys,
  normalizeConfigPatch,
  readConfig,
  saveSurvey,
  writeConfig,
} from './surveys.js';

const PREFIX = '/arxiv-inspiration/api';

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Minimal, escaped-first Markdown → HTML for the standalone analysis viewer.
 * Everything is HTML-escaped before tags are added, so raw LLM output and
 * alphaXiv page XML are always displayed as text, never interpreted.
 */
function renderAnalysisPage(arxivId, md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = String(md).split('\n');
  const out = [];
  let inList = false;
  let inPre = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const line = raw.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    if (/^\s*```/.test(raw)) {
      closeList();
      out.push(inPre ? '</pre>' : '<pre>');
      inPre = !inPre;
      continue;
    }
    if (inPre) { out.push(`${esc(raw)}`); continue; }
    if (/^#{1,2}\s/.test(raw)) {
      closeList();
      const level = raw.startsWith('##') ? 2 : 1;
      out.push(`<h${level}>${esc(raw.replace(/^#+\s*/, ''))}</h${level}>`);
    } else if (/^[-*]\s+/.test(raw)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${esc(raw.replace(/^[-*]\s+/, ''))}</li>`);
    } else if (/^---+$/.test(raw.trim())) {
      closeList();
      out.push('<hr>');
    } else if (raw.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${esc(raw)}</p>`);
    }
  }
  closeList();
  if (inPre) out.push('</pre>');
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>深读笔记 · ${esc(arxivId)}</title>
<style>
  body { font-family: -apple-system, "PingFang SC", system-ui, sans-serif; margin: 0; background: #f7f7f8; color: #1f2328; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 28px 80px; background: #fff; min-height: 100vh; box-shadow: 0 0 24px rgba(0,0,0,.06); }
  h1 { font-size: 22px; margin: 0 0 6px; }
  h2 { font-size: 17px; margin-top: 28px; }
  p, li { line-height: 1.75; font-size: 15px; }
  ul { padding-left: 22px; }
  pre { background: #f4f4f5; border-radius: 8px; padding: 12px 14px; overflow-x: auto; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  hr { border: none; border-top: 1px solid #e5e5ea; margin: 20px 0; }
  .badge { display: inline-block; font-size: 12px; color: #666; background: #f0f0f2; border-radius: 999px; padding: 2px 10px; margin-bottom: 18px; }
</style></head><body><div class="wrap">
<span class="badge">arXiv:${esc(arxivId)}</span>
${out.join('\n')}
</div></body></html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Deliver one survey into a session. Two modes:
 * - 'digest': the bilingual curated digest (title+abstract+link, ≤5 papers)
 *   intended for the user to read in the conversation.
 * - 'agent': the English injection — configurable prompt + a longer list of
 *   papers (papers_extended, `pushCount` from config) for the session agent.
 */
async function pushSurveyToSession(ctx, record, sessionId, mode = 'digest') {
  if (record.status !== 'done' || !record.result) {
    throw new Error('survey is not completed');
  }
  let text;
  if (mode === 'agent') {
    const config = await readConfig();
    const papers =
      record.result.papers_extended?.length > 0
        ? record.result.papers_extended
        : record.result.recommended;
    if (!papers?.length) throw new Error('survey has no papers to inject');
    text = renderInjection(papers, config.pushPrompt, {
      date: record.result.date_utc8,
      count: config.pushCount,
    });
  } else {
    if (!record.result.markdown) throw new Error('survey has no digest to push');
    text = record.result.markdown;
  }
  const resolved = await ctx.sessionController.resolveAgent(sessionId);
  if ('error' in resolved) throw new Error(String(resolved.error?.message ?? resolved.error));
  resolved.agent.followup({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'arxiv-inspiration' },
  });
  await kb.recordPushed(
    (record.result.recommended || []).map((r) => ({
      arxiv_id: r.arxiv_id,
      title: r.title,
      abstract: r.abstract,
      categories: r.categories,
    })),
  );
  await ctx.sessions.flush(resolved.agent.session).catch((error) => {
    ctx.logger.warn('arxiv-inspiration: session flush failed: %s', error?.message);
  });
}

/** Run one survey in the background and persist the outcome. */
function launchSurvey(ctx, record) {
  void (async () => {
    try {
      const result = await runSurvey(ctx, record.request, {
        route: record.request.route,
      });
      record.status = result?.error ? 'failed' : 'done';
      record.status_detail = result?.error ?? '';
      record.result = result ?? null;
      record.finished_at = new Date().toISOString();
    } catch (error) {
      record.status = 'failed';
      record.status_detail = String(error?.message ?? error);
      record.finished_at = new Date().toISOString();
    }
    await saveSurvey(record).catch((error) => {
      ctx.logger.warn('arxiv-inspiration: saveSurvey failed: %s', error?.message);
    });
  })();
}

export function registerRoutes(ctx) {
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && path === `${PREFIX}/config`) {
        return json(res, 200, await readConfig());
      }
      if (method === 'PUT' && path === `${PREFIX}/config`) {
        const patch = normalizeConfigPatch(await readBody(req));
        return json(res, 200, await writeConfig(patch));
      }
      // ---- P3-9 notes -----------------------------------------------------
      const notesMatch = path.match(/^\/arxiv-inspiration\/api\/papers\/([^/]+)\/notes$/);
      if (notesMatch && method === 'GET') {
        return json(res, 200, { notes: await kb.listNotes(decodeURIComponent(notesMatch[1])) });
      }
      if (notesMatch && method === 'POST') {
        const body = await readBody(req);
        if (!String(body.text ?? '').trim()) return json(res, 400, { error: 'text required' });
        const note = await kb.addNote({
          arxiv_id: decodeURIComponent(notesMatch[1]),
          text: body.text,
          author: 'user',
        });
        return json(res, 200, { ok: true, note });
      }
      // ---- deep-read analysis archive (full md note) ----------------------
      const analysisMatch = path.match(/^\/arxiv-inspiration\/api\/papers\/([^/]+)\/analysis$/);
      if (analysisMatch && method === 'GET') {
        const id = decodeURIComponent(analysisMatch[1]);
        const md = await kb.readAnalysis(id);
        if (md !== undefined) return json(res, 200, { arxiv_id: id, markdown: md });
        const lib = await kb.getPaper(id);
        if (lib?.pdf_analysis) return json(res, 200, { arxiv_id: id, markdown: lib.pdf_analysis });
        return json(res, 404, { error: 'analysis not found' });
      }
      // Standalone viewer window (like the DSH file viewer): the client opens
      // this URL directly, so it renders self-contained HTML, not JSON.
      const analysisViewMatch = path.match(/^\/arxiv-inspiration\/api\/papers\/([^/]+)\/analysis\/view$/);
      if (analysisViewMatch && method === 'GET') {
        const id = decodeURIComponent(analysisViewMatch[1]);
        let md = await kb.readAnalysis(id);
        if (md === undefined) {
          const lib = await kb.getPaper(id);
          md = lib?.pdf_analysis;
        }
        res.writeHead(md ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(md ? renderAnalysisPage(id, md) : '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px;color:#888">未找到深读笔记</body>');
        return;
      }
      // ---- P2-6 profile revision ------------------------------------------
      if (method === 'GET' && path === `${PREFIX}/profile`) {
        const [draft, since] = await Promise.all([
          kb.getProfileDraft(),
          kb.feedbackSinceLastRevision(),
        ]);
        return json(res, 200, {
          profile: await kb.getProfile(),
          draft,
          new_feedback_since_revision: since.length,
        });
      }
      if (method === 'POST' && path === `${PREFIX}/profile/draft`) {
        const config = await readConfig();
        const route = config.provider && config.model
          ? { provider: config.provider, model: config.model }
          : undefined;
        const draft = await draftProfileRevision(ctx, { route });
        await kb.saveProfileDraft(draft);
        return json(res, 200, draft);
      }
      if (method === 'POST' && path === `${PREFIX}/profile/adopt`) {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: 'text required' });
        return json(res, 200, await kb.adoptProfileDraft(text));
      }
      if (method === 'POST' && path === `${PREFIX}/profile/discard`) {
        await kb.clearProfileDraft();
        return json(res, 200, { ok: true });
      }
      if (method === 'GET' && path === `${PREFIX}/surveys`) {
        const surveys = await listSurveys();
        return json(res, 200, surveys.map(stripMarkdown));
      }
      if (method === 'POST' && path === `${PREFIX}/surveys`) {
        const overrides = await readBody(req);
        const config = await readConfig();
        const request = {
          weekdays: Array.isArray(overrides.weekdays) && overrides.weekdays.length
            ? overrides.weekdays
            : config.weekdays,
          categories: Array.isArray(overrides.categories) && overrides.categories.length
            ? overrides.categories
            : config.categories,
          includeCrossList:
            typeof overrides.includeCrossList === 'boolean'
              ? overrides.includeCrossList
              : config.includeCrossList,
          maxPush: overrides.maxPush ?? config.maxPush,
          useAlphaxivDiscovery:
            typeof overrides.useAlphaxivDiscovery === 'boolean'
              ? overrides.useAlphaxivDiscovery
              : config.useAlphaxivDiscovery !== false,
          useAlphaxivDeepRead:
            typeof overrides.useAlphaxivDeepRead === 'boolean'
              ? overrides.useAlphaxivDeepRead
              : config.useAlphaxivDeepRead !== false,
          researchContext:
            typeof overrides.researchContext === 'string' && overrides.researchContext.trim()
              ? overrides.researchContext
              : config.researchContext,
          route: config.provider && config.model
            ? { provider: config.provider, model: config.model }
            : undefined,
        };
        const record = await createSurveyRecord(request);
        launchSurvey(ctx, record);
        return json(res, 202, { id: record.id });
      }
      const surveyMatch = path.match(/^\/arxiv-inspiration\/api\/surveys\/([^/]+)(\/(feedback|push))?$/);
      if (surveyMatch) {
        const [, id, , action] = surveyMatch;
        const record = await getSurvey(id);
        if (!record) return json(res, 404, { error: 'survey not found' });
        if (method === 'GET' && !action) {
          // Detail keeps the bilingual digest markdown for in-card rendering.
          return json(res, 200, record);
        }
        if (method === 'POST' && action === 'feedback') {
          const body = await readBody(req);
          const feedback = String(body.feedback ?? '');
          if (!['interested', 'not_interested', 'read'].includes(feedback)) {
            return json(res, 400, { error: 'feedback must be interested | not_interested | read' });
          }
          const arxivId = String(body.arxivId ?? '');
          await kb.recordFeedback(arxivId, feedback, body.title);
          // Consume the feedback signal:
          // - interested → auto interest chunk (idempotent per paper)
          // - not_interested/read → recorded; surveys read it as a gentle
          //   down-ranking signal (direct id exclusion + ≤25% title-overlap
          //   penalty) at the next run.
          let interestAdded = false;
          if (feedback === 'interested') {
            const paper =
              (record.result?.recommended ?? []).find((p) => p.arxiv_id === arxivId) ??
              (body.title ? { arxiv_id: arxivId, title: String(body.title), abstract: '', categories: [] } : null);
            if (paper) {
              const outcome = await kb.addInterestForPaper(paper).catch((error) => {
                ctx.logger.warn('arxiv-inspiration: addInterestForPaper failed: %s', error?.message);
                return { added: false };
              });
              interestAdded = Boolean(outcome.added);
            }
          }
          record.feedback = { ...(record.feedback ?? {}), [arxivId]: feedback };
          await saveSurvey(record);
          return json(res, 200, { ok: true, interest_added: interestAdded });
        }
        if (method === 'POST' && action === 'push') {
          const body = await readBody(req);
          const mode = body.mode === 'agent' ? 'agent' : 'digest';
          await pushSurveyToSession(ctx, record, String(body.sessionId ?? ''), mode);
          record.pushed_to = [...(record.pushed_to ?? []), String(body.sessionId ?? '')];
          await saveSurvey(record);
          return json(res, 200, { ok: true });
        }
      }
      if (method === 'GET' && path === `${PREFIX}/models`) {
        const providers = await ctx.llm.listProviders();
        const models = {};
        for (const provider of providers) {
          try {
            models[provider.id] = (await ctx.llm.listModels(provider.id)).map((m) => ({
              id: m.id,
              name: m.name,
            }));
          } catch {
            models[provider.id] = [];
          }
        }
        const selection = ctx.agentDefaultModel?.currentSelection?.();
        return json(res, 200, {
          providers: providers.map((p) => ({ id: p.id, name: p.name })),
          models,
          default: selection ? { provider: selection.provider, model: selection.model } : null,
        });
      }
      if (method === 'GET' && path === `${PREFIX}/papers`) {
        const params = url.searchParams;
        const papers = await kb.searchPapers(params.get('query') ?? '', {
          category: params.get('category') ?? undefined,
          since: params.get('since') ?? undefined,
          feedback: params.get('feedback') ?? undefined,
          minScore: params.get('minScore') ? Number(params.get('minScore')) : undefined,
          limit: Math.min(200, Number(params.get('limit')) || 50),
          semantic: params.get('semantic') === 'true',
         });
        // has_analysis: agent-created notes (analyses/<id>.md) may exist for
        // papers that never went through survey deep-read, and the card's
        // note button must appear for them too.
        const withFlag = await Promise.all(papers.map(async (p) => ({
          ...p,
          has_analysis: p.pdf_analysis ? true : (await kb.readAnalysis(p.arxiv_id)) !== undefined,
        })));
        return json(res, 200, {
          count: papers.length,
          total: (await kb.listPapers()).length,
          papers: withFlag,
        });
      }
      if (method === 'POST' && path === `${PREFIX}/papers`) {
        const body = await readBody(req);
        const id = String(body.arxiv_id ?? body.arxivId ?? '').replace(/^.*abs\//, '').replace(/v\d+$/, '').trim();
        if (!/^[0-9.]+$|^[a-z-]+\/[0-9.]+$/i.test(id)) {
          return json(res, 400, { error: 'arxiv_id required (e.g. "2610.37596")' });
        }
        const paper = await fetchById(id);
        if (!paper) return json(res, 404, { error: `arXiv returned no entry for ${id}` });
        const enrich = new Map();
        if (body.feedback && ['interested', 'not_interested', 'read'].includes(body.feedback)) {
          enrich.set(id, { feedback: body.feedback });
          await kb.recordFeedback(id, body.feedback, paper.title).catch(() => {});
        }
        const isNew = await kb.upsertPapers([paper], { enrichments: enrich });
        kb.indexPapersInBackground().catch(() => {});
        return json(res, 200, {
          ok: true,
          added_new: isNew === 1,
          paper: { arxiv_id: paper.arxiv_id, title: paper.title, categories: paper.categories, url: paper.url },
        });
      }
      if (method === 'GET' && path === `${PREFIX}/sessions`) {
        const signal = new AbortController().signal;
        const listed = await ctx.sessionController.list({}, signal);
        const sessions = (listed?.items ?? []).map((s) => ({
          id: s.sessionId,
          title:
            s.projections?.values?.title?.text ??
            s.projections?.values?.title ??
            (s.blank ? '(blank)' : s.sessionId),
          cwd: s.cwd,
          updatedAt: s.updatedAt,
        }));
        return json(res, 200, { sessions });
      }
      return json(res, 404, { error: 'not found' });
    } catch (error) {
      ctx.logger.warn('arxiv-inspiration api error: %s', error?.message ?? error);
      return json(res, 400, { error: String(error?.message ?? error) });
    }
  };
  return ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler,
      }),
    'arxiv-inspiration: api',
  );
}

function stripMarkdown(record) {
  if (!record?.result) return record;
  return { ...record, result: { ...record.result, markdown: undefined } };
}
