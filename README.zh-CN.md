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

- DSH >=0.1.5-rc.1。
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

可选的 alphaXiv 增援（跨类目语义发现 + 带页码引用的 PDF 问答）访问
`https://api.alphaxiv.org/mcp/v1`，需要一个 Bearer token。插件本身**没有**
凭据配置项——它直接复用本机已安装的 [alphaxiv MCP
bundle](https://alphaxiv.org) 里的 token，凭据只存一处：

```
~/dsh-bundles/alphaxiv-mcp/cordis.patch.yml
```

插件在该文件中查找 `Authorization: Bearer <token>` 形式的请求头并原样
使用。如果你已经在跑 alphaxiv MCP bundle，该文件已存在，无需任何操作。
没有的话，按下述格式手动创建：

```yaml
- insert:
    - id: alphaxiv-mcp
      name: dsh-mcp-client
      config:
        mcpServers:
          alphaxiv:
            url: https://api.alphaxiv.org/mcp/v1
            headers:
              Authorization: Bearer 你的_ALPHAXIV_TOKEN
```

说明：

- token 在 alphaXiv 账户设置中获取；发现与 PDF 问答调用会消耗你的
  alphaXiv assistant 配额。
- token 只留在本机，不进入插件代码与仓库。
- 文件或 token 缺失时两个开关静默降级：调研照常运行，深读回退本地
  PyMuPDF 提取。
- token 在宿主运行期内缓存；修改文件后需重启 DSH 宿主生效。

## 安装

```bash
# 1. 把包拉进 profile
dsh plugin --profile web add github:Lxion0553/dsh-arxiv-inspiration
```

```jsonc
// 2. 在 ~/.dsh/profiles/web/package.json 里登记 bundle
//    （加到已有的 dsh.profile.bundles 数组中）
"dsh": { "profile": { "bundles": [ /* … */, "dsh-arxiv-inspiration" ] } }
```

3. 重启 DSH 宿主。

第 2 步对 CLI 安装是必须的：`dsh plugin add` 只负责取包，只有登记在
`dsh.profile.bundles` 里的 bundle 才会把它的 `cordis.patch.yml` 组合进运行
配置。从 GUI 插件市场安装会自动完成这两步。

重启后设置页出现 "arXiv Inspiration" 区块；会话获得 `arxiv_inspiration`
与 `arxiv_knowledge_base` 工具（工具在会话创建时绑定，安装后需新开会话）。

## 配置

经设置页配置（持久化到 `~/.dsh-arxiv-inspiration/config.json`）：类目、
星期、cross-list 开关、每期推荐上限、LLM provider/model、推送数量与提示词、
研究背景、alphaXiv 开关。

召回调参（同一页面）：

- **混合召回**：过滤后池子超过候选上限时，关键词通道与本地向量通道各自对全池
  排一次序，再用 RRF 倒数排名融合取前 N，而不是只保留最新的 N 篇。向量通道
  不可用（本机缺 venv/模型）或池子本来就不超上限时，自动回到按时间直取。
- **候选上限**：进入 LLM 排序的篇数（20-500）。
- **回捞窗口 / 上限**：窗口内早前调研抓过、但既未推荐也未推送过的论文，给第二
  次机会。窗口为 `0` 天即关闭。
- **token 预算 / 摘要字符**：排序提示词按估算 token 预算自动装批，取代固定篇数
  批次；摘要截断长度独立可调。

每张调研卡片还会显示召回漏斗（`抓取 + 回捞 → 候选 → 推荐`）与成本行（关键词/
语义两通道条数、LLM 批次数、估算 token 量）。

## 许可

MIT
