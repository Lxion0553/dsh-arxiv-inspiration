# arXiv Inspiration

> 中文文档 | [English](README.md)

一个 DeepSeek Harness (DSH) 插件：把 arXiv
变成个性化的科研灵感源——按本地兴趣知识库 + LLM 排序的按需调研、设置页内
查看与反馈的图形界面、持续累积的论文库，以及全文深读笔记。

## 功能

- **按需调研** — 选择星期（UTC+8）与 arXiv 类目发起调研，或在会话中用
  `arxiv_inspiration` 工具触发。抓取 → 知识库粗筛 → 并行 LLM 排序 → 逐篇
  推荐（中文推荐理由/💡启发/建议行动 + 英文 agent 上下文）。
- **设置页界面**（arXiv Inspiration 卡片）：配置类目/星期/模型/推送偏好、
  发起调研、双语标题摘要逐篇查看、👍/📖/👎 反馈——不自动推送，由你决定
  什么内容进入会话。
- **反馈闭环** — 👍 自动加入兴趣块；👎 在后续调研中温和降权（≤25% 分数
  惩罚 + 单 id 排除）。反馈同时驱动画像演化。
- **论文库** — 抓取过的论文持续累积在 `~/.dsh-arxiv-inspiration/papers.jsonl`，
  含评分、反馈、中文翻译、笔记与深读状态。支持关键词/语义检索，UI 可浏览，
  agent 可通过 `arxiv_knowledge_base` 工具操作（`search_papers`、`get_paper`、
  `add_paper` 等）。
- **深读笔记** — 推荐论文可全文精读（优先 alphaXiv PDF 问答，本地 PyMuPDF
  map-reduce 兜底）。完整笔记存于 `~/.dsh-arxiv-inspiration/analyses/<id>.md`，
  独立窗口查看；卡片只显示 3–5 条中文要点。agent 可读写笔记
  （`read_analysis` / `write_analysis`）并添加时间线笔记（`add_note` /
  `list_notes`）。
- **画像演化** — LLM 根据反馈历史起草修订版研究画像，你在界面上采纳/编辑/
  放弃；插件绝不静默改写你的画像。
- **alphaXiv 增援（可选）** — 跨类目语义发现与带页码引用的全文问答，复用
  你已有的 alphaxiv MCP 凭据；两个开关均可按调研关闭。
- **会话推送** — 把摘要（面向用户、双语）或论文列表+提示词（面向 agent）
  推送到任一会话。

## 环境要求

- DSH 宿主（版本要求见 package.json 的 `dsh.engines`）。
- DSH 中已配置 LLM provider（插件使用宿主 `llm` 服务，默认跟随会话模型
  选择；也可在设置页固定 provider/model）。
- Node.js >= 22。
- 可选（PDF 全文提取与语义检索）：Python，见下。

所有数据存于 `~/.dsh-arxiv-inspiration/`，卸载插件不会删除数据。

## Python 环境（可选，推荐）

PDF 深读与语义检索依赖一个轻量 Python 环境。没有它插件照常工作——调研、
排序、论文库、笔记均可用；PDF 深读自动跳过，语义检索自动回退关键词匹配。

推荐用 [uv](https://docs.astral.sh/uv/)：

```bash
# 1. 安装 uv（macOS / Linux）
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. 在插件数据目录建 venv（插件同时也会识别自身安装目录下的 .venv）
mkdir -p ~/.dsh-arxiv-inspiration
uv venv ~/.dsh-arxiv-inspiration/.venv

# 3. 安装两个可选依赖
uv pip install --python ~/.dsh-arxiv-inspiration/.venv/bin/python pymupdf fastembed
```

说明：

- `pymupdf` 负责 PDF 全文提取（`scripts/pdf_parse.py`）。
- `fastembed` 负责语义检索（`scripts/kb_vec.py`，bge-small-en-v1.5，ONNX
  免 torch）；模型首次使用时下载到 `~/.dsh-arxiv-inspiration/models/`。
- 系统 Python 3.12 受 PEP 668（externally-managed）限制不能直接
  `pip install`——因此推荐 uv 建 venv（macOS 上 `python3 -m venv` 可能缺
  `ensurepip`）。
- Python 解释器查找顺序：数据目录 `.venv/bin/python` → 插件安装目录
  `.venv/bin/python` → PATH 上的 `python3`。

## alphaXiv 凭据（可选）

alphaXiv 集成从已有的 alphaxiv MCP bundle 补丁文件
`~/dsh-bundles/alphaxiv-mcp/cordis.patch.yml`（`Authorization: Bearer ...`
头）读取 token。需要 alphaXiv 增援时创建该文件（或软链现有 bundle）即可。
插件内不内嵌任何 token；文件缺失时相关功能静默降级，调研照常运行。

## 安装

```bash
dsh plugin add <owner>/dsh-arxiv-inspiration
```

安装后重启 DSH 宿主。设置页出现 "arXiv Inspiration" 区块；会话获得
`arxiv_inspiration` 与 `arxiv_knowledge_base` 工具（安装后需新开会话）。

## 配置

经设置页配置（持久化到 `~/.dsh-arxiv-inspiration/config.json`）：类目、
星期、cross-list 开关、每期推荐上限、LLM provider/model、推送数量与提示词、
研究背景、alphaXiv 开关。

## 许可

MIT
