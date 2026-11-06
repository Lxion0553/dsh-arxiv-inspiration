/**
 * dsh-arxiv-inspiration — Host plugin.
 *
 * Manual-first interaction model (v5):
 * - The `arxiv_inspiration` tool runs the survey pipeline for the calling
 *   research agent and returns the result (agent_context channel). It no
 *   longer auto-pushes a digest into the conversation.
 * - A settings page (client.js) manages configuration, starts surveys,
 *   shows results, records feedback, and pushes a chosen survey's digest
 *   into a chosen session — all through the HTTP API in lib/server.js.
 * - Plugin config lives in ~/.dsh-arxiv-inspiration/config.json.
 */

import { registerRoutes } from './lib/server.js';
import { fetchById } from './lib/arxiv.js';
import { draftProfileRevision } from './lib/profile.js';
import { runSurvey } from './lib/survey.js';
import { createSurveyRecord, readConfig, saveSurvey, writeConfig } from './lib/surveys.js';
import * as kb from './lib/kb.js';

export const name = 'dsh-arxiv-inspiration';
export const inject = [
  'tools',
  'llm',
  'agentDefaultModel',
  'sessions',
  'sessionController',
  'webServer',
];

export function apply(ctx) {
  registerRoutes(ctx);

  const dispose = ctx.tools.register({
    name: 'arxiv_inspiration',
    description:
      'Fetch recent arXiv papers from specified categories within a given weekday ' +
      'window (past 7 days, UTC+8), filter by the user\u2019s research interest ' +
      'knowledge base, and return inspiration-worthy papers, including a ' +
      'research-agent context paragraph for the current session. The calling agent ' +
      'should fill research_context with a concise description of the current ' +
      'research task. The result is also saved as a survey record the user can ' +
      'review and push to a conversation from the arXiv Inspiration settings page; ' +
      'this tool does NOT push anything automatically.',
    timeoutMs: 30 * 60 * 1000, // survey pipeline can take minutes; no global cap exists
    parameters: {
      type: 'object',
      properties: {
        weekdays: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
          },
          description:
            'Which weekday(s) to fetch. Papers submitted on these weekdays within the past 7 days (UTC+8). Defaults to the plugin configuration.',
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description:
            'arXiv category codes. Defaults to the plugin configuration (initially ["cs.CL","cs.AI","cs.LG","stat.ML"]).',
        },
        include_cross_list: {
          type: 'boolean',
          description: 'Whether to include cross-listed papers. Default from plugin configuration.',
        },
        max_push: {
          type: 'integer',
          description: 'Max papers to recommend. Default 5, hard cap 5.',
        },
        research_context: {
          type: 'string',
          description:
            'Strongly recommended. The calling agent should fill in a concise description ' +
            'of the current research task, question, or project stage. Used to bias paper ' +
            'selection toward what is immediately useful for the ongoing work.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const signal = exec.signal;
      const config = await readConfig();
      const params = {
        weekdays: Array.isArray(args.weekdays) && args.weekdays.length ? args.weekdays : config.weekdays,
        categories:
          Array.isArray(args.categories) && args.categories.length ? args.categories : config.categories,
        includeCrossList:
          typeof args.include_cross_list === 'boolean' ? args.include_cross_list : config.includeCrossList,
        maxPush: args.max_push ?? config.maxPush,
        researchContext:
          typeof args.research_context === 'string' && args.research_context.trim()
            ? args.research_context
            : config.researchContext,
        // Recall / ranking knobs come from the saved config only: they are
        // tuning parameters, not per-request choices.
        hybridRanking: config.hybridRanking !== false,
        maxCandidates: config.maxCandidates,
        rankTokenBudget: config.rankTokenBudget,
        abstractChars: config.abstractChars,
        carryoverDays: config.carryoverDays,
        carryoverLimit: config.carryoverLimit,
      };
      const route = config.provider && config.model ? { provider: config.provider, model: config.model } : undefined;

      // Persist as a survey record so the settings page can show it and the
      // user can push its digest into a conversation later.
      const record = await createSurveyRecord(params);
      const result = await runSurvey(ctx, params, { signal, route });
      record.status = result?.error ? 'failed' : 'done';
      record.status_detail = result?.error ?? '';
      record.result = result ?? null;
      record.finished_at = new Date().toISOString();
      await saveSurvey(record).catch((error) => {
        ctx.logger.warn('arxiv-inspiration: saveSurvey failed: %s', error?.message);
      });

      const { markdown, ...agentResult } = result ?? {};
      return JSON.parse(
        JSON.stringify({
          ...agentResult,
          survey_id: record.id,
          push_note:
            'Recommendation saved as a survey record. The user can push the bilingual digest into a conversation from the arXiv Inspiration settings page.',
        }),
      );
    },
  });

  const disposeKb = ctx.tools.register({
    name: 'arxiv_knowledge_base',
    description:
      'Read and maintain the arXiv-inspiration research interest knowledge base ' +
      '(~/.dsh-arxiv-inspiration/). The KB drives paper filtering for the ' +
      'arxiv_inspiration survey tool. Use `get` to inspect the current profile, ' +
      'interest chunks, and default research context; use the other actions to ' +
      'update them when the user refines their research interests.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'get',
            'update_profile',
            'update_research_context',
            'add_interest',
            'remove_interest',
            'search_papers',
            'get_paper',
            'add_paper',
            'add_note',
            'list_notes',
            'read_analysis',
            'write_analysis',
            'draft_profile_revision',
          ],
          description:
            'get: return profile + interests + research context. update_profile: replace the whole ' +
            'profile.md text. update_research_context: replace the default research_context used by ' +
            'surveys. add_interest: append an interest chunk. remove_interest: delete one chunk by id. ' +
            'search_papers: query the accumulated paper library (every paper ever fetched by a survey, ' +
            'with scores, feedback, and Chinese translations when available). ' +
            'get_paper: full library entry for one arxiv_id, plus its deep-read-note state ' +
            '(analysis_path, has_analysis, analysis_head) — always call this before writing a note. ' +
            'read_analysis: full deep-read note (md) for one arxiv_id. ' +
            'write_analysis: create or replace the full deep-read note md for one arxiv_id ' +
            '(creates the standard header when the note does not exist yet; pass the complete body — ' +
            'for appending to an existing note, read_analysis first, then write the merged text). ' +
            'Deep-read notes live in ~/.dsh-arxiv-inspiration/analyses/<id>.md and are shown in the ' +
            'settings-page card via the "查看完整深读笔记" button. ' +
            'add_paper: manually add one paper to the library by arXiv id or abs URL (metadata fetched ' +
            'from arXiv; optional feedback). Use it when the user mentions a paper a survey missed.' +
            'add_note: attach a note to a paper (author=agent) — use this to record conclusions while ' +
            'reading or discussing a paper; notes are injected into future survey prompts. ' +
            'list_notes: list notes for one paper (arxiv_id) or the most recent notes across all papers. ' +
            'draft_profile_revision: generate (but do NOT apply) a revised research-interest profile ' +
            'draft from feedback history; the user adopts it in the settings page.',
        },
        query: {
          type: 'string',
          description: 'For search_papers: free-text query (title/abstract keywords).',
        },
        category: {
          type: 'string',
          description: 'For search_papers: filter by arXiv category substring (e.g. "astro-ph").',
        },
        since: {
          type: 'string',
          description: 'For search_papers: only papers first/last seen on or after this date (YYYY-MM-DD).',
        },
        feedback: {
          type: 'string',
          enum: ['interested', 'not_interested', 'read'],
          description: 'For search_papers: only papers with this feedback status.',
        },
        limit: {
          type: 'integer',
          description: 'For search_papers: max results. Default 20, cap 100.',
        },
        text: {
          type: 'string',
          description:
            'For update_profile / update_research_context: the full replacement text. ' +
            'For add_interest: the interest chunk text. For add_note: the note content. ' +
            'For write_analysis: the complete note body (markdown).',
        },
        arxiv_id: {
          type: 'string',
          description:
            'For add_note / list_notes / get_paper / read_analysis / write_analysis: the target paper.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'For add_interest: short lookup tags.',
        },
        weight: {
          type: 'number',
          description: 'For add_interest: 0-3 importance multiplier. Default 1.',
        },
        id: {
          type: 'string',
          description: 'For remove_interest: the chunk id from `get`.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      await kb.initIfMissing().catch(() => {});
      switch (args.action) {
        case 'get': {
          const [profile, interests, config] = await Promise.all([
            kb.getProfile(),
            kb.listInterests(),
            readConfig(),
          ]);
          return {
            profile,
            interests,
            research_context: config.researchContext,
            feedback_file: '~/.dsh-arxiv-inspiration/feedback.jsonl (append-only user feedback)',
          };
        }
        case 'update_profile': {
          if (!String(args.text ?? '').trim()) throw new Error('text is required for update_profile');
          await kb.writeProfile(String(args.text));
          return { ok: true, profile: await kb.getProfile() };
        }
        case 'update_research_context': {
          const next = await writeConfig({ researchContext: String(args.text ?? '') });
          return { ok: true, research_context: next.researchContext };
        }
        case 'add_interest': {
          const chunk = await kb.addInterest({
            text: args.text,
            tags: args.tags,
            weight: args.weight,
            source: 'manual',
          });
          return { ok: true, chunk };
        }
        case 'remove_interest': {
          if (!String(args.id ?? '')) throw new Error('id is required for remove_interest');
          const removed = await kb.removeInterest(String(args.id));
          return { ok: true, removed };
        }
        case 'search_papers': {
          const papers = await kb.searchPapers(String(args.query ?? ''), {
            category: args.category || undefined,
            since: args.since || undefined,
            feedback: args.feedback || undefined,
            limit: Math.min(100, Number(args.limit) || 20),
          });
          const total = (await kb.listPapers()).length;
          // Lossless-JSON guard: zh/score/feedback fields may be undefined.
          return JSON.parse(
            JSON.stringify({
              total_in_library: total,
              matched: papers.length,
              papers: papers.map((p) => ({
                arxiv_id: p.arxiv_id,
                title: p.title,
                title_zh: p.title_zh,
                categories: p.categories,
                url: p.url,
                best_score: p.scores?.length ? Math.max(...p.scores.map((s) => s.total ?? 0)) : undefined,
                feedback: p.feedback,
                abstract: p.abstract,
                abstract_zh: p.abstract_zh,
                first_seen: p.first_seen,
              })),
            }),
          );
        }
        case 'add_paper': {
          const id = String(args.arxiv_id ?? '').replace(/^.*abs\//, '').replace(/v\d+$/, '').trim();
          if (!/^[0-9.]+$|^[a-z-]+\/[0-9.]+$/i.test(id)) {
            throw new Error('arxiv_id required (e.g. "2610.37596" or an abs URL)');
          }
          const paper = await fetchById(id, exec.signal);
          if (!paper) throw new Error(`arXiv returned no entry for ${id}`);
          const enrich = new Map();
          if (args.feedback && ['interested', 'not_interested', 'read'].includes(args.feedback)) {
            enrich.set(id, { feedback: args.feedback });
            await kb.recordFeedback(id, args.feedback, paper.title).catch(() => {});
          }
          const isNew = await kb.upsertPapers([paper], { enrichments: enrich });
          kb.indexPapersInBackground().catch(() => {});
          const stored = await kb.getPaper(id);
          return {
            ok: true,
            added_new: isNew === 1,
            paper: JSON.parse(JSON.stringify({
              arxiv_id: stored.arxiv_id,
              title: stored.title,
              categories: stored.categories,
              url: stored.url,
              feedback: stored.feedback,
            })),
          };
        }
        case 'get_paper': {
          if (!String(args.arxiv_id ?? '')) throw new Error('arxiv_id is required for get_paper');
          const result = await kb.getPaperWithAnalysis(args.arxiv_id);
          if (!result.paper) {
            throw new Error(`paper ${args.arxiv_id} not in library — add it first with add_paper`);
          }
          return JSON.parse(JSON.stringify(result));
        }
        case 'read_analysis': {
          if (!String(args.arxiv_id ?? '')) throw new Error('arxiv_id is required for read_analysis');
          const markdown = await kb.readAnalysis(args.arxiv_id);
          if (markdown === undefined) {
            const lib = await kb.getPaper(args.arxiv_id);
            return {
              arxiv_id: args.arxiv_id,
              has_analysis: Boolean(lib?.pdf_analysis),
              analysis_path: kb.analysisPath(args.arxiv_id),
              markdown: lib?.pdf_analysis ?? null,
              note: lib?.pdf_analysis
                ? 'No archived md note; returned the cached pdf_analysis from papers.jsonl instead.'
                : 'No deep-read note for this paper yet. Create one with write_analysis.',
            };
          }
          return { arxiv_id: args.arxiv_id, has_analysis: true, analysis_path: kb.analysisPath(args.arxiv_id), markdown };
        }
        case 'write_analysis': {
          if (!String(args.arxiv_id ?? '')) throw new Error('arxiv_id is required for write_analysis');
          if (!String(args.text ?? '').trim()) throw new Error('text (full note body) is required for write_analysis');
          const existing = await kb.readAnalysis(args.arxiv_id);
          let body = String(args.text);
          let created = false;
          if (existing === undefined) {
            // New note: prepend the standard header so the UI viewer matches
            // survey-generated notes.
            const paper = await kb.getPaper(args.arxiv_id);
            const title = paper?.title ?? args.arxiv_id;
            body = `# 深读笔记 · ${title}\n\n- arXiv: https://arxiv.org/abs/${args.arxiv_id}\n- 生成时间: ${new Date().toISOString()}\n- 类型: agent 补充笔记\n\n---\n\n${body}`;
            created = true;
          }
          const path = await kb.writeAnalysis(args.arxiv_id, {
            title: undefined,
            analysis: body,
          }).catch(() => null);
          return JSON.parse(JSON.stringify({
            ok: true,
            created,
            analysis_path: path ?? kb.analysisPath(args.arxiv_id),
            note: created
              ? 'New note created with the standard header. Add a timeline index note with add_note.'
              : 'Existing note replaced. For pure appends prefer read_analysis → merged write to preserve prior sections.',
          }));
        }
        case 'add_note': {
          if (!String(args.arxiv_id ?? '')) throw new Error('arxiv_id is required for add_note');
          const note = await kb.addNote({
            arxiv_id: args.arxiv_id,
            text: args.text,
            author: 'agent',
            session_id: exec.agent?.id,
          });
          return { ok: true, note };
        }
        case 'list_notes': {
          const notes = await kb.listNotes(args.arxiv_id || undefined);
          return {
            count: notes.length,
            notes: notes.slice(0, Math.min(100, Number(args.limit) || 20)),
          };
        }
        case 'draft_profile_revision': {
          const config = await readConfig();
          const route = config.provider && config.model
            ? { provider: config.provider, model: config.model }
            : undefined;
          const draft = await draftProfileRevision(ctx, { route, signal: exec.signal });
          return {
            ...draft,
            note: 'Draft generated but NOT applied. The user adopts it in the arXiv Inspiration settings page (or via update_profile with explicit user approval).',
          };
        }
        default:
          throw new Error(`unknown action: ${args.action}`);
      }
    },
  });

  return () => {
    dispose();
    disposeKb();
  };
}
