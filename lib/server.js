/**
 * Same-origin HTTP API for the settings page, registered on the host
 * webServer under /arxiv-inspiration/api/*. The web UI fetches these with
 * relative URLs; the server binds loopback by default.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve as resolvePath, sep as pathSep } from 'node:path';

import * as kb from './kb.js';
import { fetchById } from './arxiv.js';
import { fetchAndParsePdf } from './pdf.js';
import { ensurePaperInVault, paperReaderPrompt } from './agentero.js';
import { draftProfileRevision } from './profile.js';
import { renderCollectionInjection, renderDiscoveryInjection, renderInjection, runSurvey, runRecheck } from './survey.js';
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

/**
 * Resolve an agentero vault asset request to an absolute file path, or an
 * error string. Only files INSIDE the configured agenteroPapersDir are
 * served; symlinks are resolved before the containment check.
 */
export function resolveAgenteroAsset(rootDir, target) {
  if (!rootDir || !target) return { error: 'agentero dir not configured' };
  let root;
  try {
    root = realpathSync(resolvePath(rootDir));
  } catch {
    return { error: 'agentero dir not found' };
  }
  let abs;
  try {
    abs = realpathSync(resolvePath(target));
  } catch {
    return { error: 'not found' };
  }
  if (abs !== root && !abs.startsWith(root + pathSep)) return { error: 'outside agentero dir' };
  return { abs };
}

const ASSET_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Rewrite agentero NOTES.md for in-app MarkdownText rendering:
 * - strip the Obsidian frontmatter block;
 * - wiki links [[target|label]] → label (plain, no internal target);
 * - relative link/image targets → SAME-ORIGIN asset URLs, absolutized
 *   against `origin` (e.g. http://127.0.0.1:3080, passed by the caller
 *   from the request host). The platform MarkdownText image renderer
 *   only accepts absolute http(s)/blob/data srcs — root-relative URLs
 *   would render as plain alt text instead of <img>.
 *   Images resolve against the note's own dir; Obsidian vault-root links
 *   like `papers/<id>/<id>.pdf` resolve against the dir ABOVE the vault's
 *   `papers/` folder, i.e. against <agenteroDir>'s parent.
 * External http(s)/dsh-resource/mailto links pass through untouched.
 */
export function rewriteAgenteroLinks(md, notePath, origin = '') {
  const noteDir = String(notePath).replace(/\/NOTES\.md$/, '');
  const agenteroDir = noteDir.split('/').slice(0, -1).join('/');
  const vaultRoot = agenteroDir.split('/').slice(0, -1).join('/');
  const assetUrl = (abs, frag) =>
    `${origin}/arxiv-inspiration/api/agentero/asset?path=${encodeURIComponent(abs)}${frag ? `#${frag}` : ''}`;
  let out = String(md).replace(/^---\n[\s\S]*?\n---\n/, '');
  out = out
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1');
  out = out.replace(/(\]\()([^)\s]*)([^)]*\))/g, (m, head, target, tail) => {
    if (!target || /^(https?:|dsh-resource:|mailto:|#|data:)/.test(target)) return m;
    const hashIdx = target.indexOf('#');
    const frag = hashIdx >= 0 ? target.slice(hashIdx + 1) : '';
    const base = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
    if (!base) return m;
    let abs;
    if (base.startsWith('papers/')) abs = resolvePath(`${vaultRoot}/${base}`);
    else if (base.startsWith('/')) abs = resolvePath(base);
    else abs = resolvePath(`${noteDir}/${base}`);
    return `${head}${assetUrl(abs, frag)}${tail}`;
  });
  return out;
}

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
      // Math if it has LaTeX/scripts, is a short space-free token, or is a
      // short math-only expression (variables, tuples, equations — no CJK).
      /[\\^_]/.test(inner)
      || (inner.length <= 8 && !/\s/.test(inner))
      || (inner.length <= 24 && !/[\u4e00-\u9fff]/.test(inner) && /^[A-Za-z0-9()\[\]<>,.\s,=+\-|:~×·\/]+$/.test(inner))
        ? convert(inner) : m));
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
/**
 * Active collection rows merged with their papers.jsonl metadata (snapshot
 * fallback for ids that never entered the library).
 */
async function collectionWithLibrary() {
  const items = await kb.listCollection();
  const lib = new Map((await kb.listPapers()).map((p) => [p.arxiv_id, p]));
  const agenteroDir = (await readConfig()).agenteroPapersDir;
  return Promise.all(items.map(async (row) => {
    const p = lib.get(row.arxiv_id) ?? {};
    // has_analysis covers BOTH survey deep-read caches and agent-written
    // notes (analyses/<id>.md) — the same rule the library view uses.
    const hasNote = Boolean(p.pdf_analysis) || (await kb.readAnalysis(row.arxiv_id)) !== undefined;
    const agenteroPath = agenteroDir && existsSync(kb.agenteroNotePath(agenteroDir, row.arxiv_id))
      ? kb.agenteroNotePath(agenteroDir, row.arxiv_id)
      : undefined;
    return {
      arxiv_id: row.arxiv_id,
      title: p.title || row.title || row.arxiv_id,
      title_zh: p.title_zh ?? '',
      categories: p.categories ?? [],
      url: p.url || `https://arxiv.org/abs/${row.arxiv_id}`,
      abstract: p.abstract ?? '',
      feedback: p.feedback ?? null,
      has_analysis: hasNote,
      analysis_path: hasNote ? kb.analysisPath(row.arxiv_id) : undefined,
      has_agentero: Boolean(agenteroPath),
      agentero_path: agenteroPath,
      has_fulltext: await kb.readFulltext(row.arxiv_id) !== undefined,
      fulltext_path: (await kb.readFulltext(row.arxiv_id)) !== undefined
        ? kb.fulltextPath(row.arxiv_id)
        : undefined,
      source: row.source,
      note: row.note ?? '',
      added_at: row.added_at,
      in_library: Boolean(p.arxiv_id),
    };
  }));
}

/** Fetch + archive one paper's full text (PDF → text) in the background.
 * Returns true when the text ends up archived. */
async function ensureFulltext(ctx, arxivId) {
  const existing = await kb.readFulltext(arxivId);
  if (existing !== undefined) return true;
  const libPaper = await kb.getPaper(arxivId).catch(() => null);
  const paper = {
    arxiv_id: arxivId,
    pdf_url: libPaper?.pdf_url || `https://arxiv.org/pdf/${arxivId}`,
  };
  const text = await fetchAndParsePdf(paper, undefined, kb);
  return Boolean(text && text.trim());
}

/** Sequentially fill in missing full texts for the whole collection. */
function backfillCollectionFulltext(ctx) {
  return (async () => {
    let done = 0;
    const missing = (await collectionWithLibrary()).filter((m) => !m.has_fulltext);
    for (const m of missing) {
      try {
        await ensureFulltext(ctx, m.arxiv_id);
      } catch (error) {
        ctx.logger.warn(
          'arxiv-inspiration: fulltext fetch failed for %s: %s',
          m.arxiv_id,
          error?.message,
        );
      }
      done++;
      ctx.logger.info('arxiv-inspiration: fulltext backfill %d/%d', done, missing.length);
    }
    return { queued: missing.length, done };
  })();
}

async function pushSurveyToSession(ctx, record, sessionId, mode = 'digest') {
  if (record.status !== 'done' || !record.result) {
    throw new Error('survey is not completed');
  }
  const config = await readConfig();
  // Reference external agentero deep-dives when they exist (引用不合并).
  const withAgenteroPaths = (papers) => {
    if (!config.agenteroPapersDir || !papers?.length) return papers;
    return papers.map((p) => {
      const notePath = kb.agenteroNotePath(config.agenteroPapersDir, p.arxiv_id);
      return existsSync(notePath) ? { ...p, agentero_path: notePath } : p;
    });
  };
  let text;
  if (mode === 'agent') {
    let papers =
      record.result.papers_extended?.length > 0
        ? record.result.papers_extended
        : record.result.recommended;
    if (!papers?.length) throw new Error('survey has no papers to inject');
    // pushCount is the paper budget: 0 means the 50-paper ceiling.
    const { pushCount } = resolvePushLimits(config);
    papers = withAgenteroPaths(papers);
    text = renderInjection(papers, config.pushPrompt, {
      date: record.result.date_utc8,
      count: pushCount,
    });
    // Semantic-discovery picks (语义发现) ride along as a separate English
    // block — they are outside the weekday window by design.
    const discovery = record.result.discovery ?? [];
    if (discovery.length > 0) {
      text += `\n\n${renderDiscoveryInjection(withAgenteroPaths(discovery))}`;
    }
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
    [...(record.result.recommended || []), ...(record.result.discovery || [])].map((r) => ({
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

/** Auto-collect a finished record's recommendation list into the push
 * collection (config autoCollect, default on). Tombstoned ids stay out.
 * Covers the main recommendations AND the semantic-discovery picks (语义发现).
 * Shared by surveys and library rechecks. */
async function autoCollectIfConfigured(ctx, record) {
  if (record.status !== 'done' || !record.result) return;
  const collectible = [
    ...(record.result.recommended ?? []),
    ...(record.result.discovery ?? []),
  ];
  if (collectible.length === 0) return;
  try {
    const config = await readConfig();
    if (config.autoCollect) {
      const added = await kb.autoCollectRecommended(collectible, record.id);
      if (added > 0) {
        ctx.logger.info('arxiv-inspiration: auto-collected %d papers into the push list', added);
      }
    }
  } catch (error) {
    ctx.logger.warn('arxiv-inspiration: auto-collect failed: %s', error?.message);
  }
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
    await autoCollectIfConfigured(ctx, record);
  })();
}

/** Run one library recheck in the background. Progress is persisted into the
 * record (stage + batch counter) so the settings page's 5s poll can show it. */
function launchRecheck(ctx, record) {
  void (async () => {
    try {
      const result = await runRecheck(ctx, record.request, {
        route: record.request.route,
        onProgress: (p) => {
          record.progress = p;
          saveSurvey(record).catch(() => {});
        },
      });
      record.status = result?.error ? 'failed' : 'done';
      record.status_detail = result?.error ?? '';
      record.result = result ?? null;
      record.progress = { stage: 'done', done: 1, total: 1 };
      record.finished_at = new Date().toISOString();
    } catch (error) {
      record.status = 'failed';
      record.status_detail = String(error?.message ?? error);
      record.finished_at = new Date().toISOString();
    }
    await saveSurvey(record).catch((error) => {
      ctx.logger.warn('arxiv-inspiration: saveSurvey failed: %s', error?.message);
    });
    await autoCollectIfConfigured(ctx, record);
  })();
}

/**
 * Build + launch a library recheck record from raw overrides (settings-page
 * POST body or the agent tool). Shared by both entry points.
 */
export async function startRecheck(ctx, overrides = {}) {
  const config = await readConfig();
  const request = {
    type: 'recheck',
    includeRecommended: overrides.includeRecommended === true || overrides.include_recommended === true,
    includePushed: overrides.includePushed === true || overrides.include_pushed === true,
    fullRescan: overrides.fullRescan === true || overrides.full_rescan === true,
    since: String(overrides.since ?? '').slice(0, 10),
    until: String(overrides.until ?? '').slice(0, 10),
    maxPush: overrides.maxPush ?? config.maxPush,
    pushCount: overrides.pushCount ?? config.pushCount,
    rankTokenBudget: numberOr(overrides.rankTokenBudget, config.rankTokenBudget),
    abstractChars: numberOr(overrides.abstractChars, config.abstractChars),
    researchContext:
      typeof overrides.researchContext === 'string' && overrides.researchContext.trim()
        ? overrides.researchContext
        : config.researchContext,
    route: config.provider && config.model
      ? { provider: config.provider, model: config.model }
      : undefined,
  };
  const record = await createSurveyRecord(request);
  launchRecheck(ctx, record);
  return record;
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
      // ---- agentero paper-reader note (external vault, referenced only) --
      const agenteroMatch = path.match(/^\/arxiv-inspiration\/api\/papers\/([^/]+)\/agentero$/);
      if (agenteroMatch && method === 'GET') {
        const id = decodeURIComponent(agenteroMatch[1]);
        const config = await readConfig();
        const notePath = config.agenteroPapersDir
          ? kb.agenteroNotePath(config.agenteroPapersDir, id)
          : '';
        const md = await kb.readAgenteroNote(config.agenteroPapersDir, id);
        if (md === undefined) return json(res, 404, { error: 'agentero note not found' });
        // Absolute origin so MarkdownText renders <img> (it rejects
        // root-relative srcs); loopback host is stable per client.
        const host = String(req.headers.host ?? '127.0.0.1:3080');
        const proto = String(req.headers['x-forwarded-proto'] ?? 'http');
        return json(res, 200, {
          arxiv_id: id,
          path: notePath,
          markdown: md,
          rendered: rewriteAgenteroLinks(md, notePath, `${proto}://${host}`),
        });
      }
      // agentero vault asset (image/pdf) — same-origin so <img> in the notes
      // tab can load it; strictly contained inside agenteroPapersDir.
      if (method === 'GET' && path === `${PREFIX}/agentero/asset`) {
        const config = await readConfig();
        const target = url.searchParams.get('path') ?? '';
        const resolvedAsset = resolveAgenteroAsset(config.agenteroPapersDir, target);
        if (resolvedAsset.error) {
          const status = resolvedAsset.error === 'outside agentero dir' ? 403
            : resolvedAsset.error === 'agentero dir not configured' ? 400 : 404;
          return json(res, status, { error: resolvedAsset.error });
        }
        if (!existsSync(resolvedAsset.abs)) return json(res, 404, { error: 'not found' });
        try {
          const buf = await readFile(resolvedAsset.abs);
          const type = ASSET_TYPES[extname(resolvedAsset.abs).toLowerCase()]
            ?? 'application/octet-stream';
          res.writeHead(200, {
            'content-type': type,
            'cache-control': 'private, max-age=86400',
          });
          res.end(buf);
        } catch {
          return json(res, 404, { error: 'unreadable' });
        }
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
        // Library recheck (库内重评): a funnel re-evaluation of papers.jsonl
        // against the CURRENT profile — separate launch path and record shape.
        if (overrides.mode === 'recheck') {
          const record = await startRecheck(ctx, overrides);
          return json(res, 202, { id: record.id, type: 'recheck' });
        }
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
      // ---- push collection (accumulated paper pool) -----------------------
      const collectionMatch = path.match(/^\/arxiv-inspiration\/api\/collection(\/push|\/fulltext)?$/);
      if (collectionMatch && collectionMatch[1] === '/fulltext' && method === 'POST') {
        // Batch backfill: archive missing full texts for the whole
        // collection, sequentially in the background. The UI polls
        // GET /collection (5s) and watches has_fulltext light up.
        const merged = await collectionWithLibrary();
        const missing = merged.filter((m) => !m.has_fulltext).length;
        if (missing === 0) return json(res, 200, { ok: true, queued: 0 });
        void backfillCollectionFulltext(ctx);
        return json(res, 202, { ok: true, queued: missing });
      }
      if (collectionMatch && !collectionMatch[1]) {
        if (method === 'GET') {
          const merged = await collectionWithLibrary();
          const auto = merged.filter((m) => String(m.source).startsWith('survey')).length;
          return json(res, 200, {
            total: merged.length,
            auto_collected: auto,
            manual: merged.length - auto,
            items: merged,
          });
        }
        if (method === 'POST') {
          const body = await readBody(req);
          const id = String(body.arxiv_id ?? body.arxivId ?? '')
            .replace(/^.*abs\//, '')
            .replace(/v[0-9]+$/, '')
            .trim();
          let title = String(body.title ?? '');
          // Papers outside the library get their metadata fetched and stored,
          // so later pushes and the library view both have full records.
          let fetched = false;
          if (!(await kb.getPaper(id))) {
            try {
              const paper = await fetchById(id);
              if (paper) {
                await kb.upsertPapers([paper]);
                kb.indexPapersInBackground().catch(() => {});
                fetched = true;
              }
            } catch {
              /* keep the caller-provided snapshot below */
            }
          }
          const outcome = await kb.addToCollection({
            arxiv_id: id,
            title,
            source: 'manual',
            note: String(body.note ?? ''),
          });
          // Manual adds: make sure the full text is archived so the push
          // message can reference it (fetch runs in the background).
          ensureFulltext(ctx, id).catch((error) => {
            ctx.logger.warn(
              'arxiv-inspiration: fulltext fetch for %s failed: %s',
              id,
              error?.message,
            );
          });
          return json(res, 200, { ok: true, added: outcome.added, fetched, item: outcome.item });
        }
        if (method === 'DELETE') {
          const cleared = await kb.clearCollection();
          return json(res, 200, { ok: true, cleared });
        }
      }
      if (collectionMatch && collectionMatch[1] === '/push' && method === 'POST') {
        const body = await readBody(req);
        const sessionId = String(body.sessionId ?? '');
        if (!sessionId) return json(res, 400, { error: 'sessionId required' });
        const merged = await collectionWithLibrary();
        if (!merged.length) return json(res, 400, { error: 'collection is empty' });
        const text = renderCollectionInjection(merged, { note: String(body.note ?? '') });
        const resolved = await ctx.sessionController.resolveAgent(sessionId);
        if ('error' in resolved) throw new Error(String(resolved.error?.message ?? resolved.error));
        resolved.agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'arxiv-inspiration' },
        });
        await kb.recordPushed(
          merged.map((m) => ({
            arxiv_id: m.arxiv_id,
            title: m.title,
            abstract: m.abstract,
            categories: m.categories,
          })),
        ).catch(() => {});
        await ctx.sessions.flush(resolved.agent.session).catch((error) => {
          ctx.logger.warn('arxiv-inspiration: session flush failed: %s', error?.message);
        });
        const clear = body.clear === true;
        let cleared = 0;
        if (clear) cleared = await kb.clearCollection();
        return json(res, 200, { ok: true, pushed: merged.length, chars: text.length, cleared });
      }
      // 「🧠 paper-reader 精读」: agentero import + download only, then hand the
      // actual deep read to a session that carries the paper-reader skill.
      // agentero explicitly does not run paper-reader, so the plugin never
      // generates these notes itself.
      if (method === 'POST' && path === `${PREFIX}/paper-reader/prepare`) {
        const body = await readBody(req);
        const id = String(body.arxiv_id ?? body.arxivId ?? '')
          .replace(/^.*abs\//, '')
          .replace(/v\d+$/, '')
          .trim();
        if (!/^[0-9.]+$|^[a-z-]+\/[0-9.]+$/i.test(id)) {
          return json(res, 400, { error: 'arxiv_id required (e.g. "2610.37596")' });
        }
        const config = await readConfig();
        if (!config.agenteroPapersDir) {
          return json(res, 400, { error: 'agenteroPapersDir is not configured (设置页「paper-reader 目录」)' });
        }
        const listed = await ctx.sessionController.list({}, new AbortController().signal);
        // Raw list items expose sessionId + projections (NOT id/title — those
        // are the /sessions route's mapped shape). Mirror that mapping here.
        const items = (listed?.items ?? []).map((s) => ({
          id: s.sessionId,
          title:
            s.projections?.values?.title?.text ??
            s.projections?.values?.title ??
            (s.blank ? '(blank)' : s.sessionId),
          cwd: s.cwd,
        }));
        const wanted = String(config.paperReaderSessionId ?? '').trim();
        const target = wanted
          ? items.find((s) => s.id === wanted)
          : items.find((s) => String(s.title ?? '').toLowerCase().includes('paper reader'));
        if (!target) {
          return json(res, 400, {
            error: wanted
              ? `paper-reader session not found: ${wanted}`
              : 'no session titled "Paper Reader Command" — pick one in 设置页「paper-reader 会话」',
            sessions: items.map((s) => ({ id: s.id, title: s.title })),
          });
        }
        const vaulted = await ensurePaperInVault({
          vaultRoot: dirname(config.agenteroPapersDir),
          papersDir: config.agenteroPapersDir,
          arxivId: id,
        });
        if (!vaulted.vaulted) {
          return json(res, 502, {
            error: vaulted.error || 'could not add the paper to the agentero vault',
            steps: vaulted.steps,
          });
        }
        const sessionCwd = target.cwd || dirname(config.agenteroPapersDir);
        const rel = relative(sessionCwd, vaulted.pdfPath);
        const ref = rel && !rel.startsWith('..') ? rel.split(pathSep).join('/') : vaulted.pdfPath;
        const text = paperReaderPrompt(ref, vaulted.pdfPath);
        const resolved = await ctx.sessionController.resolveAgent(target.id);
        if ('error' in resolved) {
          return json(res, 502, { error: String(resolved.error?.message ?? resolved.error) });
        }
        resolved.agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'arxiv-inspiration' },
        });
        await ctx.sessions.flush(resolved.agent.session).catch((error) => {
          ctx.logger.warn('arxiv-inspiration: session flush failed: %s', error?.message);
        });
        return json(res, 200, {
          ok: true,
          arxiv_id: id,
          sessionId: target.id,
          sessionTitle: target.title ?? '',
          pdfPath: vaulted.pdfPath,
          steps: vaulted.steps,
        });
      }
      const collectionIdMatch = path.match(/^\/arxiv-inspiration\/api\/collection\/([^/]+)$/);
      if (collectionIdMatch && method === 'DELETE') {
        const removed = await kb.removeFromCollection(decodeURIComponent(collectionIdMatch[1]));
        if (!removed) return json(res, 404, { error: 'paper not in collection' });
        return json(res, 200, { ok: true, removed: true });
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
          // has-note flags mirror GET /papers' withFlag so cards can decide
          // whether the「查看深读笔记」jump makes sense for each paper.
          const agenteroDir = (await readConfig()).agenteroPapersDir;
          const hasNoteByBase = new Map();
          const hasNoteFor = async (id) => {
            if (!hasNoteByBase.has(id)) {
              hasNoteByBase.set(id, {
                has_analysis: await kb.readAnalysis(id) !== undefined,
                agentero_path: agenteroDir && existsSync(kb.agenteroNotePath(agenteroDir, id))
                  ? kb.agenteroNotePath(agenteroDir, id)
                  : undefined,
              });
            }
            return hasNoteByBase.get(id);
          };
          const normalizePapers = async (papers) => {
            if (!Array.isArray(papers)) return papers;
            return Promise.all(papers.map(async (p) => {
              const q = { ...p };
              for (const k of TEXT_FIELDS) if (k in q) q[k] = norm(q[k]);
              const flags = await hasNoteFor(q.arxiv_id);
              // A summary riding on the record itself also proves our note exists.
              q.has_analysis = Boolean(q.pdf_analysis || q.pdf_analysis_summary) || flags.has_analysis;
              q.has_agentero = Boolean(flags.agentero_path);
              if (flags.agentero_path) q.agentero_path = flags.agentero_path;
              return q;
            }));
          };
          const shaped = {
            ...record,
            result: record.result && typeof record.result === 'object'
              ? {
                  ...record.result,
                  recommended: await normalizePapers(record.result.recommended),
                  discovery: await normalizePapers(record.result.discovery),
                  papers_extended: await normalizePapers(record.result.papers_extended),
                  worth_a_look: await normalizePapers(record.result.worth_a_look),
                }
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
          offset: Math.max(0, Math.min(10000, Number(params.get('offset')) || 0)),
          semantic: params.get('semantic') === 'true',
          sort: params.get('sort') ?? 'recent',
         });
        // has_analysis: agent-created notes (analyses/<id>.md) may exist for
        // papers that never went through survey deep-read, and the card's
        // note button must appear for them too.
        const agenteroDir = (await readConfig()).agenteroPapersDir;
        const withFlag = await Promise.all(papers.map(async (p) => {
          // analysis_path: absolute md-note path for opening in the Web GUI
          // sidebar document preview (built-in markdown + KaTeX rendering).
          const note = p.pdf_analysis ? true : (await kb.readAnalysis(p.arxiv_id)) !== undefined;
          const agenteroPath = agenteroDir && existsSync(kb.agenteroNotePath(agenteroDir, p.arxiv_id))
            ? kb.agenteroNotePath(agenteroDir, p.arxiv_id)
            : undefined;
          return {
            ...p,
            has_analysis: note,
            analysis_path: note ? kb.analysisPath(p.arxiv_id) : undefined,
            has_agentero: Boolean(agenteroPath),
            agentero_path: agenteroPath,
          };
        }));
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
