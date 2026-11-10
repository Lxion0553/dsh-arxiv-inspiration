/**
 * Thin adapter over the `agentero` CLI (agentero-dsh).
 *
 * agentero owns the paper vault (catalog, PDF/TeX download, NOTES.md shells)
 * but explicitly does NOT run paper-reader — its own help says "Does not run
 * agents or paper-reader". So this module only covers the mechanical half of
 * 「🧠 paper-reader 精读」: make sure the paper exists in the vault with a local
 * PDF. The deep-read itself is delegated to a session that carries the
 * paper-reader skill (see POST /paper-reader/prepare in server.js).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_TIMEOUT_MS = 180000;

/**
 * Run the CLI and resolve with the exit code — a non-zero exit is reported to
 * the caller instead of thrown, because "already in catalog" is a normal
 * outcome we want to inspect rather than treat as a crash.
 */
export function runAgentero(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('agentero', args, {
        cwd: cwd || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          error?.code === 'ENOENT'
            ? 'agentero CLI not found on PATH — install the agentero-dsh plugin first'
            : String(error?.message ?? error),
        ),
      );
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, signal: signal ?? null, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Parse agentero's `--json` stdout; returns undefined when it is not JSON. */
function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/** `<papersDir>/<id>/<id>.pdf` — the path layout agentero uses. */
export function paperPdfPath(papersDir, arxivId) {
  return join(papersDir, arxivId, `${arxivId}.pdf`);
}

/**
 * Ensure one arXiv id is present in the agentero vault WITH a local PDF.
 *
 * Order: PDF already on disk → done; directory exists but PDF missing →
 * `agentero paper download`; nothing yet → `agentero import id` (catalog +
 * shell, no paper-reader), then download if the import did not fetch it.
 *
 * Returns { vaulted, pdfPath, steps:[...], notes, error? }. Never throws for
 * CLI-level failures — the caller surfaces `error` to the UI.
 */
export async function ensurePaperInVault({ vaultRoot, papersDir, arxivId, timeoutMs } = {}) {
  const id = String(arxivId ?? '').trim();
  const steps = [];
  const result = { vaulted: false, pdfPath: '', steps };
  if (!papersDir) {
    result.error = 'agenteroPapersDir is not configured';
    return result;
  }
  if (!id) {
    result.error = 'arxiv_id required';
    return result;
  }
  const pdfPath = paperPdfPath(papersDir, id);
  result.pdfPath = pdfPath;
  if (existsSync(pdfPath)) {
    result.vaulted = true;
    result.steps.push('already-in-vault');
    return result;
  }
  const root = vaultRoot || dirname(papersDir);
  const base = ['--vault', root, '--json'];
  const dirExists = existsSync(join(papersDir, id));
  // A missing/unrunnable CLI must surface as data, not an exception: the
  // endpoint turns `error` into 502 with the install hint.
  const safeRun = async (args) => {
    try {
      return await runAgentero(args, { cwd: root, timeoutMs });
    } catch (error) {
      return { code: -1, signal: null, stdout: '', stderr: String(error?.message ?? error) };
    }
  };

  if (!dirExists) {
    const imported = await safeRun(['import', 'id', id, ...base]);
    steps.push(`import:${imported.code}`);
    if (imported.code !== 0) {
      // Already catalogued is a benign race; anything else is a real failure
      // unless the download below happens to succeed.
      result.importError = imported.stderr || imported.stdout || `exit ${imported.code}`;
    } else {
      result.notes = parseJson(imported.stdout);
    }
  } else {
    steps.push('dir-exists');
  }

  if (existsSync(pdfPath)) {
    result.vaulted = true;
    return result;
  }

  const downloaded = await safeRun(['paper', 'download', id, ...base]);
  steps.push(`download:${downloaded.code}`);
  if (downloaded.code !== 0) {
    result.error = downloaded.stderr || downloaded.stdout || `agentero paper download exited ${downloaded.code}`;
  }
  result.vaulted = existsSync(pdfPath);
  if (!result.vaulted && !result.error) {
    result.error = `agentero did not produce ${pdfPath}`;
  }
  if (result.vaulted) delete result.importError;
  return result;
}

/**
 * Prompt pushed into the paper-reader session. The leading slash form mirrors
 * how the user invokes the skill by hand; the following line is a fallback for
 * the case where an injected message is delivered as plain text and the slash
 * command is therefore not expanded.
 */
export function paperReaderPrompt(ref, absolutePath) {
  const lines = [
    `/paper-reader ${ref}`,
    `（若上面的斜杠命令未被识别，请直接用 paper-reader skill 精读该 PDF，并把讲义式笔记写入同一目录的 NOTES.md）`,
  ];
  // The vault path usually contains spaces ("DeepLearning in Astronomy"), so
  // the slash form uses the vault-relative path; the absolute one is spelled
  // out on its own line for the model rather than as a fragile reference.
  if (absolutePath && absolutePath !== ref) lines.push(`绝对路径 / absolute path: ${absolutePath}`);
  return lines.join('\n');
}
