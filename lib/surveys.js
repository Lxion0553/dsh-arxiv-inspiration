/**
 * Survey records + plugin config, stored under ~/.dsh-arxiv-inspiration/.
 * surveys/<id>.json — one file per survey run (status: running|done|failed).
 * config.json — plugin settings edited from the settings page.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { WEEKDAY_OPTIONS } from './survey.js';

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
  maxPush: 5,
  researchContext: '',
  provider: '',
  model: '',
  pushCount: 15,
  pushPrompt: DEFAULT_PUSH_PROMPT,
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

/** Validate + normalize a config patch coming from the settings page. */
export function normalizeConfigPatch(patch) {
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
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error('maxPush must be an integer 1-5');
    clean.maxPush = n;
  }
  if (patch.researchContext !== undefined) clean.researchContext = String(patch.researchContext).slice(0, 4000);
  if (patch.pushCount !== undefined) {
    const n = Number(patch.pushCount);
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('pushCount must be an integer 1-20');
    clean.pushCount = n;
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
