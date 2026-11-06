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
  resolvePushLimits,
  saveSurvey,
  writeConfig,
} from './surveys.js';

const PREFIX = '/arxiv-inspiration/api';

/** Numeric override → finite number, else the fallback (config/default). */
function numberOr(value, fallback) {
  const n = Number(value);
  return value === undefined || value === null || value === '' || !Number.isFinite(n) ? fallback : n;
}

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
/**
 * Display-only LaTeX cleanup: converts the common subset found in abstracts
 * and LLM-written Chinese notes (greek letters, \times, sub/superscripts,
 * $...$ delimiters) into unicode so plain-text UI shows real formulas.
 * Anything unrecognized is left untouched. Safe to run on any string.
 */
function mathToUnicode(text) {
  if (typeof text !== 'string') return text;
  if (!text.includes('$') && !text.includes('\\') && !text.includes('^') && !text.includes('_')) return text;
  const GREEK = { alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',varepsilon:'ε',zeta:'ζ',eta:'η',theta:'θ',vartheta:'ϑ',iota:'ι',kappa:'κ',lambda:'λ',mu:'μ',nu:'ν',xi:'ξ',pi:'π',rho:'ρ',sigma:'σ',tau:'τ',upsilon:'υ',phi:'φ',varphi:'φ',chi:'χ',psi:'ψ',omega:'ω',Gamma:'Γ',Delta:'Δ',Theta:'Θ',Lambda:'Λ',Xi:'Ξ',Pi:'Π',Sigma:'Σ',Phi:'Φ',Psi:'Ψ',Omega:'Ω' };
  const SYM = { times:'×',div:'÷',pm:'±',mp:'∓',leq:'≤',le:'≤',geq:'≥',ge:'≥',neq:'≠',ne:'≠',approx:'≈',sim:'∼',propto:'∝',infty:'∞',partial:'∂',nabla:'∇',cdot:'·',cdots:'⋯',ldots:'…',dots:'…',rightarrow:'→',to:'→',leftarrow:'←',Rightarrow:'⇒',mapsto:'↦',langle:'⟨',rangle:'⟩',lesssim:'≲',gtrsim:'≳',equiv:'≡',perp:'⊥',parallel:'∥',in:'∈',circ:'∘',degree:'°',prime:'′',hbar:'ℏ',ell:'ℓ',mid:'∣',odot:'⊙',oplus:'⊕',otimes:'⊗',ast:'∗',star:'⋆',wedge:'∧',vee:'∨',cup:'∪',cap:'∩',subset:'⊂',subseteq:'⊆',emptyset:'∅',varnothing:'∅',forall:'∀',exists:'∃',neg:'¬',simeq:'≃',asymp:'≍',cong:'≅',ll:'≪',gg:'≫',sum:'∑',prod:'∏',int:'∫' };;
  const SUP = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ' };
  const SUB = { '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','=':'₌','(':'₍',')':'₎','a':'ₐ','e':'ₑ','i':'ᵢ','o':'ₒ','x':'ₓ' };
  const script = (inner, map) => {
    const out = [...inner].map((c) => map[c] ?? null);
    return out.every(Boolean) ? out.join('') : null;
  };
  const convert = (src) => {
    let t = src;
    for (let i = 0; i < 4; i += 1) {
      const before = t;
      t = t.replace(/\\sqrt\{([^{}]*)\}/g, '√($1)');
      t = t.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)');
      t = t.replace(/\\mathbb\{(R|E|P|N|Z|Q|C)\}/g, (m, c) => ({R:'ℝ',E:'𝔼',P:'ℙ',N:'ℕ',Z:'ℤ',Q:'ℚ',C:'ℂ'})[c]);
    t = t.replace(/\\mathcal\{(X|Y|P|F|L|U|A|B|C|D|G|H|S|T|M|N)\}/g, (m, c) => ({X:'𝒳',Y:'𝒴',P:'𝒫',F:'ℱ',L:'ℒ',U:'𝒰',A:'𝒜',B:'ℬ',C:'𝒞',D:'𝒟',G:'𝒢',H:'ℋ',S:'𝒮',T:'𝒯',M:'ℳ',N:'𝒩'})[c]);
    t = t.replace(/\\(?:text|mathrm|mathbf|mathit|emph|operatorname|mathbb|mathcal|mathscr|mathfrak|mathsf|mathtt)\{([^{}]*)\}/g, '$1');
      if (t === before) break;
    }
    t = t.replace(/\\(?:hat|widehat)\{([^{}]*)\}/g, '$1̂');
    t = t.replace(/\\(?:tilde|widetilde)\{([^{}]*)\}/g, '$1̃');
    t = t.replace(/\\bar\{([^{}]*)\}/g, '$1̄');
    t = t.replace(/\\(left|right|big|Big|bigl|bigr|Bigl|Bigr|middle)\b/g, '');
    t = t.replace(/\\\\\|/g, '‖');
    t = t.replace(/\\\|/g, '‖');
    t = t.replace(/\\(rm|bf|it|cal|sf|tt)\b/g, '');
    t = t.replace(/\\([A-Za-z]+)/g, (m, name) => GREEK[name] ?? SYM[name] ?? name);
    t = t.replace(/\^\{([^{}]*)\}/g, (m, inner) => script(inner.trim(), SUP) ?? `^(${inner.trim()})`);
    t = t.replace(/_\{([^{}]*)\}/g, (m, inner) => script(inner.trim(), SUB) ?? `_(${inner.trim()})`);
    t = t.replace(/~/g, ' ');
    t = t.replace(/\^([A-Za-z0-9+\-=])/g, (m, c) => SUP[c] ?? m);
    t = t.replace(/_([A-Za-z0-9+\-=])/g, (m, c) => SUB[c] ?? m);
    t = t.replace(/\\[,;!]/g, ' ');
    t = t.replace(/\\#/g, '#');
    return t;
  };
  // Bare LaTeX fragments outside $...$: known \commands and ^{..}/_{..}/^c/_c
  // scripts. Safe for prose: ^ _ \ essentially never occur in normal Chinese/English text.
  const bare = (t) => t
    .replace(/\\(rm|bf|it|cal|sf|tt)\b/g, '')
    .replace(/\\([A-Za-z]+)/g, (m, name) => GREEK[name] ?? SYM[name] ?? m)
    .replace(/\^\{([^{}]*)\}/g, (m, inner) => script(inner, SUP) ?? `^(${inner})`)
    .replace(/_\{([^{}]*)\}/g, (m, inner) => script(inner.trim(), SUB) ?? `_(${inner.trim()})`)
    .replace(/\^([A-Za-z0-9+\-=])/g, (m, c) => SUP[c] ?? m)
    .replace(/_([A-Za-z0-9+\-=])/g, (m, c) => SUB[c] ?? m);
  // Display math $$...$$ first (dollars dropped, structure flattened to text);
  // then inline $...$ spans that actually look like math (protects "$5 ... $10");
  // then sweep bare fragments in the remaining plain text.
  const display = (inner) => convert(inner
    .replace(/\\begin\{[A-Za-z*]+\}/g, '')
    .replace(/\\end\{[A-Za-z*]+\}/g, '')
    .replace(/\\tag\{([^{}]*)\}/g, '  ($1)')
    .replace(/\\\\/g, ';  ')
    .replace(/&/g, '  '));
  return bare(text
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, inner) => display(inner))
    .replace(/\$([^$\n]+)\$/g, (m, inner) =>
      /[\\^_]/.test(inner) || (inner.length <= 8 && !/\s/.test(inner)) ? convert(inner) : m));
}

function renderAnalysisPage(arxivId, md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Inline markdown: **bold**, *italic*, `code`, [text](url) — applied to
  // already-escaped, already-LaTeX-converted text; the code-path only emits
  // the tags below, so no injection is possible through note content.
  const inline = (t) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = String(md).split('\n');
  const out = [];
  let inList = false;
  let inPre = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    // Escape first, then convert LaTeX to unicode: the converter emits only
    // plain characters, so no HTML can be injected through math markup.
    const safe = mathToUnicode(esc(raw));
    const line = inline(safe);
    if (/^\s*```/.test(raw)) {
      closeList();
      out.push(inPre ? '</pre>' : '<pre>');
      inPre = !inPre;
      continue;
    }
    if (inPre) { out.push(esc(raw)); continue; }
    const heading = raw.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(mathToUnicode(esc(heading[2])))}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(raw) || /^\s*\d+\.\s+/.test(raw)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(mathToUnicode(esc(raw.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))))}</li>`);
    } else if (/^>\s?/.test(raw)) {
      closeList();
      out.push(`<blockquote>${line.replace(/^&gt;\s?/, '')}</blockquote>`);
    } else if (/^---+$/.test(raw.trim())) {
      closeList();
      out.push('<hr>');
    } else if (raw.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${line}</p>`);
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
  p, li { line-height: 1.85; font-size: 15px; text-align: justify; }
  p { margin: 10px 0; }
  ul { padding-left: 22px; }
  pre { background: #f4f4f5; border-radius: 8px; padding: 12px 14px; overflow-x: auto; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  h3 { font-size: 15.5px; margin-top: 22px; }
  h4 { font-size: 14.5px; margin-top: 18px; }
  blockquote { margin: 10px 0; padding: 6px 14px; border-left: 3px solid #d8d8dc; color: #555; background: #fafafa; border-radius: 0 6px 6px 0; }
  code { background: #f0f0f2; border-radius: 4px; padding: 1px 5px; font-size: 13px; }
  a { color: #0969da; }
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
    // pushCount is the paper budget: 0 means the 50-paper ceiling.
    const { pushCount } = resolvePushLimits(config);
    text = renderInjection(papers, config.pushPrompt, {
      date: record.result.date_utc8,
      count: pushCount,
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
        // `base` lets the cross-field rule (maxPush <= pushCount) see the value
        // this patch does not carry.
        const patch = normalizeConfigPatch(await readBody(req), await readConfig());
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
      // Raw deep-read material (full-fidelity alphaXiv pages / map-reduce
      // bullets), served as plain text in its own viewer tab.
      const rawMatch = path.match(/^\/arxiv-inspiration\/api\/papers\/([^/]+)\/analysis\/raw$/);
      if (rawMatch && method === 'GET') {
        const id = decodeURIComponent(rawMatch[1]);
        const raw = await kb.readAnalysisRaw(id);
        res.writeHead(raw === undefined ? 404 : 200, {
          'content-type': 'text/plain; charset=utf-8',
        });
        res.end(raw ?? `no raw material archived for ${id}`);
        return;
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
          pushCount: overrides.pushCount ?? config.pushCount,
          useAlphaxivDiscovery:
            typeof overrides.useAlphaxivDiscovery === 'boolean'
              ? overrides.useAlphaxivDiscovery
              : config.useAlphaxivDiscovery !== false,
          useAlphaxivDeepRead:
            typeof overrides.useAlphaxivDeepRead === 'boolean'
              ? overrides.useAlphaxivDeepRead
              : config.useAlphaxivDeepRead !== false,
          // Recall / batching knobs: per-request override when supplied,
          // otherwise the saved config (which itself falls back to defaults).
          hybridRanking:
            typeof overrides.hybridRanking === 'boolean'
              ? overrides.hybridRanking
              : config.hybridRanking !== false,
          maxCandidates: numberOr(overrides.maxCandidates, config.maxCandidates),
          rankTokenBudget: numberOr(overrides.rankTokenBudget, config.rankTokenBudget),
          abstractChars: numberOr(overrides.abstractChars, config.abstractChars),
          carryoverDays: numberOr(overrides.carryoverDays, config.carryoverDays),
          carryoverLimit: numberOr(overrides.carryoverLimit, config.carryoverLimit),
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
          // Normalize LaTeX to readable Unicode server-side so cards render
          // correctly even if the browser still holds a stale client bundle
          // (client-side conversion is idempotent on top of this).
          const TEXT_FIELDS = ['reason', 'inspiration', 'suggested_action', 'title_zh', 'abstract_zh', 'abstract', 'title', 'pdf_analysis_summary'];
          const norm = (v) => (typeof v === 'string' ? mathToUnicode(v) : v);
          const normalizePapers = (papers) => (Array.isArray(papers) ? papers.map((p) => {
            const q = { ...p };
            for (const k of TEXT_FIELDS) if (k in q) q[k] = norm(q[k]);
            return q;
          }) : papers);
          const shaped = {
            ...record,
            result: record.result && typeof record.result === 'object'
              ? { ...record.result, recommended: normalizePapers(record.result.recommended), papers_extended: normalizePapers(record.result.papers_extended) }
              : record.result,
          };
          return json(res, 200, shaped);
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
          sort: params.get('sort') ?? 'recent',
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
