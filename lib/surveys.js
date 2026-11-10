/**
 * Survey records + plugin config, stored under ~/.dsh-arxiv-inspiration/.
 * surveys/<id>.json — one file per survey run (status: running|done|failed).
 * config.json — plugin settings edited from the settings page.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { PUSH_COUNT_MAX, WEEKDAY_OPTIONS } from './survey.js';

const KB_DIR = path.join(homedir(), '.dsh-arxiv-inspiration');
const SURVEY_DIR = path.join(KB_DIR, 'surveys');
const CONFIG = path.join(KB_DIR, 'config.json');

export const DEFAULT_PUSH_PROMPT =
  'You are receiving a list of recent arXiv papers selected as potentially relevant ' +
  'to this project. Read the list, identify any paper that can directly help the ' +
  'current research task (methods to try, baselines to compare against, or results ' +
  'that change your assumptions), and use them as reference material in your next ' +
  'steps. Cite papers by arXiv id when you rely on them.';

export const DEFAULT_CONFIG = {
  categories: ['cs.CL', 'cs.AI', 'cs.LG', 'stat.ML'],
  weekdays: ['thursday', 'friday'],
  includeCrossList: false,
  useAlphaxivDiscovery: true,
  useAlphaxivDeepRead: true,
  // Candidate recall: both lanes over the whole pool, RRF-fused, then capped.
  hybridRanking: true,
  maxCandidates: 200,
  // Token-aware ranking batches (replaces the old fixed paper-count batches).
  rankTokenBudget: 18000,
  abstractChars: 1600,
  // Second chances for papers an earlier survey fetched but never offered.
  carryoverDays: 10,
  carryoverLimit: 40,
  // 推荐数：0 = 跟随推送篇数（= 推荐全部预算内的论文）。不得超过 pushCount。
  maxPush: 0,
  researchContext: '',
  // agentero paper-reader 笔记库根目录（<dir>/<arxivId>/NOTES.md + source/ 图片）。
  // 空字符串 = 未接入；只做路径引用，绝不合并内容（引用不合并原则）。
  agenteroPapersDir: '',
  // 「🧠 paper-reader 精读」把论文派给哪个会话（该会话装着 paper-reader skill）。
  // 空字符串 = 自动匹配标题含 "Paper Reader Command" 的会话。
  paperReaderSessionId: '',
  provider: '',
  model: '',
  // 推送篇数（论文预算）：注入给会话 agent 的条数上限，也是推荐数的天花板。
  // 0 = 顶到硬上限 PUSH_COUNT_MAX（50）。
  pushCount: 0,
  pushPrompt: DEFAULT_PUSH_PROMPT,
  // 调研完成后把最终推荐列表自动收进推送清单（collection.jsonl）。
  autoCollect: true,
};

export async function readConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG, 'utf8'));
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(patch) {
  const next = { ...(await readConfig()), ...patch };
  await mkdir(KB_DIR, { recursive: true });
  await writeFile(CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/**
 * Resolve the two paper budgets from raw config values.
 * pushCount is clamped to PUSH_COUNT_MAX (0 = the cap), and maxPush is clamped
 * to pushCount (0 = follow pushCount). Used by both the survey pipeline and the
 * session-push path so they never disagree.
 */
export function resolvePushLimits({ maxPush, pushCount } = {}) {
  const rawPush = Number(pushCount);
  const push = Number.isFinite(rawPush) && rawPush > 0
    ? Math.min(PUSH_COUNT_MAX, Math.floor(rawPush))
    : PUSH_COUNT_MAX;
  const rawMax = Number(maxPush);
  const wanted = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : push;
  return { pushCount: push, maxPush: Math.min(wanted, push) };
}

/** Validate + normalize a config patch coming from the settings page. */
export function normalizeConfigPatch(patch, base) {
  const clean = {};
  if (patch.categories !== undefined) {
    const cats = String(patch.categories)
      .split(/[,\s]+/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (cats.length === 0) throw new Error('categories must list at least one arXiv category');
    clean.categories = cats;
  }
  if (patch.weekdays !== undefined) {
    const days = Array.isArray(patch.weekdays)
      ? patch.weekdays
      : String(patch.weekdays).split(/[,\s]+/);
    const valid = days.map((d) => String(d).toLowerCase()).filter((d) => WEEKDAY_OPTIONS.includes(d));
    if (valid.length === 0) throw new Error('weekdays must contain at least one valid weekday');
    clean.weekdays = valid;
  }
  if (patch.includeCrossList !== undefined) clean.includeCrossList = patch.includeCrossList === true;
  if (patch.useAlphaxivDiscovery !== undefined) clean.useAlphaxivDiscovery = patch.useAlphaxivDiscovery === true;
  if (patch.useAlphaxivDeepRead !== undefined) clean.useAlphaxivDeepRead = patch.useAlphaxivDeepRead === true;
  if (patch.hybridRanking !== undefined) clean.hybridRanking = patch.hybridRanking === true;
  if (patch.autoCollect !== undefined) clean.autoCollect = patch.autoCollect === true;
  const intInRange = (value, min, max, name) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}-${max}`);
    return n;
  };
  if (patch.maxCandidates !== undefined) clean.maxCandidates = intInRange(patch.maxCandidates, 20, 500, 'maxCandidates');
  if (patch.rankTokenBudget !== undefined) {
    clean.rankTokenBudget = intInRange(patch.rankTokenBudget, 4000, 60000, 'rankTokenBudget');
  }
  if (patch.abstractChars !== undefined) clean.abstractChars = intInRange(patch.abstractChars, 400, 4000, 'abstractChars');
  if (patch.carryoverDays !== undefined) clean.carryoverDays = intInRange(patch.carryoverDays, 0, 30, 'carryoverDays');
  if (patch.carryoverLimit !== undefined) {
    clean.carryoverLimit = intInRange(patch.carryoverLimit, 0, 200, 'carryoverLimit');
  }
  if (patch.maxPush !== undefined) {
    const n = Number(patch.maxPush);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error('maxPush must be an integer >= 0 (0 = follow pushCount)');
    }
    clean.maxPush = n;
  }
  if (patch.researchContext !== undefined) clean.researchContext = String(patch.researchContext).slice(0, 4000);
  if (patch.agenteroPapersDir !== undefined) clean.agenteroPapersDir = String(patch.agenteroPapersDir).trim().slice(0, 500);
  if (patch.paperReaderSessionId !== undefined) {
    clean.paperReaderSessionId = String(patch.paperReaderSessionId).trim().slice(0, 120);
  }
  if (patch.pushCount !== undefined) {
    const n = Number(patch.pushCount);
    if (!Number.isInteger(n) || n < 0 || n > PUSH_COUNT_MAX) {
      throw new Error(
        `pushCount must be an integer 0-${PUSH_COUNT_MAX} (0 = full ${PUSH_COUNT_MAX})`,
      );
    }
    clean.pushCount = n;
  }
  // 跨字段：推荐数不得超过推送篇数。`base` 是保存前的完整配置，用来补齐
  // 本次 patch 没有携带的那一项（例如只改 pushCount 却让旧 maxPush 超标）。
  const merged = { ...DEFAULT_CONFIG, ...(base || {}), ...clean };
  const limits = resolvePushLimits(merged);
  const touchedBudget = clean.maxPush !== undefined || clean.pushCount !== undefined;
  // 0 = 跟随（永远合法）；显式值必须落在 pushCount 之内——两个方向都查，
  // 例如把 pushCount 从 50 降到 10 时，旧的 maxPush=30 也会被拦下而不是静默钳制。
  const declaredMax = Number(merged.maxPush) || 0;
  if (touchedBudget && declaredMax > limits.pushCount) {
    throw new Error(
      `maxPush (${declaredMax}) must not exceed pushCount (${limits.pushCount})`,
    );
  }
  if (patch.pushPrompt !== undefined) clean.pushPrompt = String(patch.pushPrompt).slice(0, 8000);
  if (patch.provider !== undefined) clean.provider = String(patch.provider).trim().slice(0, 200);
  if (patch.model !== undefined) clean.model = String(patch.model).trim().slice(0, 200);
  return clean;
}

export async function createSurveyRecord(request) {
  await mkdir(SURVEY_DIR, { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + randomUUID().slice(0, 8);
  const record = {
    id,
    created_at: new Date().toISOString(),
    status: 'running',
    status_detail: '',
    request,
    result: null,
    pushed_to: [],
  };
  await saveSurvey(record);
  return record;
}

export async function saveSurvey(record) {
  await mkdir(SURVEY_DIR, { recursive: true });
  await writeFile(path.join(SURVEY_DIR, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
}

export async function getSurvey(id) {
  // Ids are <ISO date> + '-' + a hex uuid slice, so letters are expected.
  if (!/^[0-9A-Za-zT\-]+$/.test(String(id)) || id.includes('..')) return undefined;
  try {
    return JSON.parse(await readFile(path.join(SURVEY_DIR, `${id}.json`), 'utf8'));
  } catch {
    return undefined;
  }
}

export async function listSurveys() {
  try {
    const files = await readdir(SURVEY_DIR);
    const records = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(SURVEY_DIR, file), 'utf8')));
      } catch {
        /* skip malformed */
      }
    }
    return records.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  } catch {
    return [];
  }
}
