# arXiv Inspiration

> [中文文档](README.zh-CN.md)

A DeepSeek Harness (DSH) plugin that turns
arXiv into a personalized research-inspiration feed: on-demand surveys filtered
by a local interest knowledge base + LLM ranking, a settings-page UI to review
and give feedback, an accumulating paper library, and full-text deep-read notes.

## Features

- **On-demand surveys** — pick weekdays (UTC+8) and arXiv categories, or run
  from a session with the `arxiv_inspiration` tool. Papers are fetched, coarse
  filtered by your KB, ranked in parallel LLM batches, and distilled into
  per-paper recommendations (中文推荐理由/💡启发/建议行动 + English agent context).
- **Settings-page UI** (arXiv Inspiration card): configure categories/weekdays/
  model/push preferences, launch surveys, review results with bilingual
  title/abstract, and give 👍/📖/👎 feedback — no auto-push, you decide what
  reaches a conversation.
- **Feedback loop** — 👍 auto-adds an interest chunk; 👎 gently down-ranks
  similar titles in later surveys (≤25% score penalty, single id exclusion).
  Feedback also feeds profile evolution.
- **Paper library** — every fetched paper accumulates in
  `~/.dsh-arxiv-inspiration/papers.jsonl` with scores, feedback, Chinese
  translations, notes, and deep-read state. Searchable (keyword + optional
  semantic), browsable in the UI, and queryable by agents via
  `arxiv_knowledge_base` tool actions (`search_papers`, `get_paper`,
  `add_paper`, …).
- **Deep-read notes** — recommended papers can be read full-text (alphaXiv PDF
  Q&A as preferred source, local PyMuPDF map-reduce as fallback). Full notes
  live in `~/.dsh-arxiv-inspiration/analyses/<id>.md` and open in a standalone
  viewer window; cards show a 3–5 bullet Chinese summary. Agents can read and
  write notes (`read_analysis` / `write_analysis`) and attach timeline notes
  (`add_note` / `list_notes`).
- **Profile evolution** — LLM drafts a revised research-interest profile from
  your feedback history; you adopt/edit/discard it in the UI. The plugin never
  silently rewrites your profile.
- **alphaXiv assist (optional)** — semantic paper discovery beyond configured
  categories and cited full-text Q&A, via your existing alphaxiv MCP
  credentials. Both toggles can be disabled per survey.
- **Session push** — push a digest (user-facing, bilingual) or a paper list +
  prompt (agent-facing) into any conversation you choose.

## Requirements

- DSH host >=0.1.5-rc.1.
- An LLM provider configured in DSH (the plugin uses the host `llm` service
  and your session model selection by default; a specific provider/model can
  be pinned in settings).
- Node.js >= 22.
- Optional, for PDF full-text extraction and semantic search: Python (below).

All data is stored under `~/.dsh-arxiv-inspiration/`. Uninstalling the plugin
does not delete it.

## Python setup (optional, recommended)

PDF deep-read and semantic search use a small Python environment. Without it
the plugin still works — surveys, ranking, library, and notes run fine; PDF
deep-read is skipped and semantic search falls back to keyword matching.

The recommended way is [uv](https://docs.astral.sh/uv/):

```bash
# 1. Install uv (macOS / Linux)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. Create a venv inside the plugin data dir (the plugin also auto-detects
#    .venv inside its own install directory)
mkdir -p ~/.dsh-arxiv-inspiration
uv venv ~/.dsh-arxiv-inspiration/.venv

# 3. Install the two extras
uv pip install --python ~/.dsh-arxiv-inspiration/.venv/bin/python pymupdf fastembed
```

Notes:

- `pymupdf` powers PDF text extraction (`scripts/pdf_parse.py`).
- `fastembed` powers semantic search (`scripts/kb_vec.py`, bge-small-en-v1.5,
  ONNX, no torch). The model downloads on first use to
  `~/.dsh-arxiv-inspiration/models/`.
- System Python 3.12 with PEP 668 (externally-managed environment) rejects
  direct `pip install` — that is why a venv via `uv` is recommended
  (`python3 -m venv` may lack `ensurepip` on macOS).
- The plugin resolves Python as: `.venv/bin/python` in its install directory
  first, then `.venv/bin/python` in `~/.dsh-arxiv-inspiration/`, then plain
  `python3` on PATH.

## alphaXiv credentials (optional)

The optional alphaXiv assist (semantic discovery + PDF Q&A with page
citations) talks to `https://api.alphaxiv.org/mcp/v1` with a Bearer token.
The plugin does **not** have a config field for it — it reuses the token from
a locally installed [alphaxiv MCP bundle](https://alphaxiv.org), so the
credential lives in exactly one place:

```
~/dsh-bundles/alphaxiv-mcp/cordis.patch.yml
```

The plugin scans that file for a header line matching
`Authorization: Bearer <token>` and uses it as-is. If you already run the
alphaxiv MCP bundle, the file exists and nothing to do. Otherwise create it
manually with the same shape the bundle uses, e.g.:

```yaml
- insert:
    - id: alphaxiv-mcp
      name: dsh-mcp-client
      config:
        mcpServers:
          alphaxiv:
            url: https://api.alphaxiv.org/mcp/v1
            headers:
              Authorization: Bearer YOUR_ALPHAXIV_TOKEN
```

Notes:

- Get a token from your alphaXiv account settings; calls to discovery/PDF
  Q&A consume your alphaXiv assistant quota.
- The token never leaves your machine; nothing is embedded in this plugin or
  its repo.
- No file / no token: both alphaXiv toggles degrade silently — surveys still
  run, deep-read falls back to local PyMuPDF extraction.
- Token cached for the host's lifetime; edit the file and restart the DSH
  host to pick up a new one.

## Install

```bash
dsh plugin add Lxion0553/dsh-arxiv-inspiration
```

Then restart the DSH host. The settings page gains an "arXiv Inspiration"
section; sessions gain the `arxiv_inspiration` and `arxiv_knowledge_base`
tools (open a new session after install).

## Configuration

Via the settings page (persisted to `~/.dsh-arxiv-inspiration/config.json`):
categories, weekdays, cross-list toggle, max papers per digest, LLM
provider/model, push count & prompt, research context, alphaXiv toggles.

## License

MIT
