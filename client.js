/**
 * arXiv Inspiration — settings page (client half).
 *
 * Registers one `settings.section` page: configuration form, survey launcher,
 * result browser with per-paper feedback, and manual push-to-session.
 * All data flows through the host HTTP API at /arxiv-inspiration/api/*.
 */

window.__ModuleLoader__.load({
  id: 'dsh-arxiv-inspiration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const API = '/arxiv-inspiration/api';
    const WEEKDAYS = [
      ['monday', '一'],
      ['tuesday', '二'],
      ['wednesday', '三'],
      ['thursday', '四'],
      ['friday', '五'],
      ['saturday', '六'],
      ['sunday', '日'],
    ];

    async function api(path, options = {}) {
      const res = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    }

    const css = `
.arxiv-page { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
.arxiv-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.arxiv-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.arxiv-sub { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.arxiv-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.arxiv-label { color: var(--dsw-alias-label-secondary); font-size: 12px; min-width: 110px; }
.arxiv-input, .arxiv-select, .arxiv-textarea { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 6px 10px; font-size: 13px; font-family: inherit; }
.arxiv-textarea { width: 100%; min-height: 56px; resize: vertical; }
.arxiv-input { flex: 1; min-width: 220px; }
.arxiv-chip { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 3px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.arxiv-chip[data-on='true'] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.arxiv-btn { background: var(--dsw-alias-brand-primary); border: none; border-radius: 6px; color: var(--dsw-alias-bg-base); padding: 7px 16px; font-size: 13px; cursor: pointer; }
.arxiv-btn:disabled { opacity: 0.5; cursor: default; }
.arxiv-btn-ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.arxiv-survey { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.arxiv-badge { font-size: 11px; border-radius: 4px; padding: 1px 8px; }
.arxiv-badge[data-s='running'] { color: var(--dsw-alias-state-warn-primary); border: 1px solid var(--dsw-alias-state-warn-primary); }
.arxiv-badge[data-s='done'] { color: var(--dsw-alias-state-success-primary); border: 1px solid var(--dsw-alias-state-success-primary); }
.arxiv-badge[data-s='failed'] { color: var(--dsw-alias-state-error-primary); border: 1px solid var(--dsw-alias-state-error-primary); }
.arxiv-paper { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.arxiv-paper a { color: var(--dsw-alias-brand-primary); text-decoration: none; font-size: 13px; font-weight: 600; }
.arxiv-abs { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
.arxiv-meta { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.arxiv-fb { font-size: 12px; cursor: pointer; border-radius: 5px; padding: 3px 9px; background: transparent; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.arxiv-fb[data-on='true'] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.arxiv-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.arxiv-md { display: flex; flex-direction: column; gap: 6px; }
.arxiv-md-h1 { margin: 0 0 4px; font-size: 15px; font-weight: 700; color: var(--dsw-alias-label-primary); }
.arxiv-md-h2 { margin: 6px 0 2px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.arxiv-md-h3 { margin: 4px 0 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.arxiv-md-p { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.arxiv-md-p a { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.arxiv-quote { border-left: 3px solid var(--dsw-alias-border-l2); padding: 2px 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
.arxiv-md-hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1); margin: 6px 0; }
.arxiv-paper-title { color: var(--dsw-alias-brand-primary); text-decoration: none; font-size: 13px; font-weight: 600; }
.arxiv-title-zh { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; margin-top: 2px; }
.arxiv-quote-zh { margin-top: 2px; }
`;

    function Field(label, children) {
      return h('div', { className: 'arxiv-row' },
        h('span', { className: 'arxiv-label' }, label), children);
    }

    function ConfigForm({ config, setConfig, dirty, onSave, saving, error, modelCatalog, defaultRoute }) {
      const toggleDay = (day) => {
        const on = config.weekdays.includes(day);
        setConfig({
          ...config,
          weekdays: on ? config.weekdays.filter((d) => d !== day) : [...config.weekdays, day],
        });
      };
      return h('div', { className: 'arxiv-card' },
        h('h3', { className: 'arxiv-title' }, '调研配置 / Survey Defaults'),
        Field('分区 Categories',
          h('input', {
            className: 'arxiv-input', value: config.categories.join(', '),
            onChange: (e) => setConfig({ ...config, categories: e.target.value.split(/[,\s]+/).filter(Boolean) }),
            placeholder: 'cs.CL, cs.AI, cs.LG, stat.ML',
          })),
        Field('星期 Weekdays',
          WEEKDAYS.map(([day, cn]) =>
            h('button', {
              key: day, className: 'arxiv-chip', 'data-on': String(config.weekdays.includes(day)),
              onClick: () => toggleDay(day), type: 'button',
            }, `${day} 周${cn}`))),
        Field('Cross-list',
          h('button', {
            className: 'arxiv-chip', 'data-on': String(config.includeCrossList === true), type: 'button',
            onClick: () => setConfig({ ...config, includeCrossList: !config.includeCrossList }),
            role: 'switch', 'aria-checked': String(config.includeCrossList === true),
          }, config.includeCrossList ? '包含 cross-list' : '仅主分类')),
        Field('alphaXiv 增援',
          h('div', { className: 'arxiv-row' },
            h('button', {
              className: 'arxiv-chip', 'data-on': String(config.useAlphaxivDiscovery !== false), type: 'button',
              onClick: () => setConfig({ ...config, useAlphaxivDiscovery: config.useAlphaxivDiscovery === false }),
              role: 'switch', 'aria-checked': String(config.useAlphaxivDiscovery !== false),
              title: '调研时用 alphaXiv 语义发现增补跨类目论文（每次调研 1 次调用，失败自动跳过）',
            }, config.useAlphaxivDiscovery !== false ? '语义发现：开' : '语义发现：关'),
            h('button', {
              className: 'arxiv-chip', 'data-on': String(config.useAlphaxivDeepRead !== false), type: 'button',
              onClick: () => setConfig({ ...config, useAlphaxivDeepRead: config.useAlphaxivDeepRead === false }),
              role: 'switch', 'aria-checked': String(config.useAlphaxivDeepRead !== false),
              title: '深读优先走 alphaXiv PDF 查询（只读相关页，省 token；失败回退本地 PyMuPDF 全文分析）',
            }, config.useAlphaxivDeepRead !== false ? '深读：alphaXiv 优先' : '深读：仅本地'))),
        Field('推荐数 Max',
          h('div', { className: 'arxiv-row' },
            h('input', {
              className: 'arxiv-input', type: 'number', min: 0, max: config.pushCount > 0 ? config.pushCount : 50,
              value: config.maxPush ?? 0,
              onChange: (e) => setConfig({ ...config, maxPush: Math.max(0, Math.floor(Number(e.target.value) || 0)) }),
              style: { maxWidth: 90 },
            }),
            h('span', { className: 'arxiv-meta' }, '0 = 跟随推送篇数（推荐全部）。不得超过推送篇数；喂给 LLM 的篇数也跟随此值。'))),
        Field('混合召回',
          h('div', { className: 'arxiv-row' },
            h('button', {
              className: 'arxiv-chip', 'data-on': String(config.hybridRanking !== false), type: 'button',
              onClick: () => setConfig({ ...config, hybridRanking: config.hybridRanking === false }),
              role: 'switch', 'aria-checked': String(config.hybridRanking !== false),
              title: '池子超过候选上限时，关键词与本地向量两条通道各排一次，用 RRF 融合取前 N（比只保留最新论文更能捞到相关性高的旧稿）',
            }, config.hybridRanking !== false ? '关键词 + 向量：开' : '关键词 + 向量：关'),
            h('span', { className: 'arxiv-meta' }, '候选上限'),
            h('input', {
              className: 'arxiv-input', type: 'number', min: 20, max: 500,
              value: config.maxCandidates ?? 200,
              onChange: (e) => setConfig({ ...config, maxCandidates: Number(e.target.value) || 200 }),
              style: { maxWidth: 90 },
            }))),
        Field('回捞 Carry-over',
          h('div', { className: 'arxiv-row' },
            h('span', { className: 'arxiv-meta' }, '窗口(天)'),
            h('input', {
              className: 'arxiv-input', type: 'number', min: 0, max: 30, value: config.carryoverDays ?? 10,
              onChange: (e) => setConfig({ ...config, carryoverDays: Number(e.target.value) || 0 }),
              style: { maxWidth: 80 },
            }),
            h('span', { className: 'arxiv-meta' }, '上限'),
            h('input', {
              className: 'arxiv-input', type: 'number', min: 0, max: 200,
              value: config.carryoverLimit ?? 40,
              onChange: (e) => setConfig({ ...config, carryoverLimit: Number(e.target.value) || 0 }),
              style: { maxWidth: 80 },
            }),
            h('span', { className: 'arxiv-meta' },
              '窗口=0 关闭；只回捞窗口内抓过、但从未推荐过也未推送过的论文'),
            )),
        Field('排序批处理',
          h('div', { className: 'arxiv-row' },
            h('span', { className: 'arxiv-meta' }, 'token 预算'),
            h('input', {
              className: 'arxiv-input', type: 'number', min: 4000, max: 60000,
              value: config.rankTokenBudget ?? 18000,
              onChange: (e) => setConfig({ ...config, rankTokenBudget: Number(e.target.value) || 18000 }),
              style: { maxWidth: 100 },
            }),
            h('span', { className: 'arxiv-meta' }, '摘要字符'),
            h('input', {
              className: 'arxiv-input', type: 'number', min: 400, max: 4000,
              value: config.abstractChars ?? 1600,
              onChange: (e) => setConfig({ ...config, abstractChars: Number(e.target.value) || 1600 }),
              style: { maxWidth: 100 },
            }),
            h('span', { className: 'arxiv-meta' },
              '按 token 预算自动装批，取代固定篇数/固定截断'),
            )),
        Field('LLM 模型',
          h('div', { className: 'arxiv-row' },
            h('select', {
              className: 'arxiv-select', value: config.provider ?? '',
              onChange: (e) => setConfig({ ...config, provider: e.target.value, model: '' }),
            },
              h('option', { value: '' },
                defaultRoute ? `跟随 DSH 默认 (${defaultRoute.provider})` : '跟随 DSH 默认'),
              (modelCatalog?.providers ?? []).map((p) =>
                h('option', { key: p.id, value: p.id }, p.name || p.id))),
            h('select', {
              className: 'arxiv-select', value: config.model ?? '',
              onChange: (e) => setConfig({ ...config, model: e.target.value }),
            },
              h('option', { value: '' },
                config.provider
                  ? '选择模型…'
                  : defaultRoute
                    ? `跟随 DSH 默认 (${defaultRoute.model})`
                    : '跟随 DSH 默认'),
              (modelCatalog?.models?.[config.provider] ?? []).map((m) =>
                h('option', { key: m.id, value: m.id }, m.name || m.id))))),
        Field('推送篇数 Push',
          h('div', { className: 'arxiv-row' },
            h('input', {
              className: 'arxiv-input', type: 'number', min: 0, max: 50, value: config.pushCount ?? 0,
              onChange: (e) => setConfig({ ...config, pushCount: Math.max(0, Math.floor(Number(e.target.value) || 0)) }),
              style: { maxWidth: 90 },
            }),
            h('span', { className: 'arxiv-meta' }, '本次调研的论文预算：注入给 agent 的条数上限，也是推荐数的天花板。0 = 上限 50。'))),
        h('div', { className: 'arxiv-row' },
          h('span', { className: 'arxiv-label' }, '注入提示词'),
          h('textarea', {
            className: 'arxiv-textarea', value: config.pushPrompt ?? '',
            onChange: (e) => setConfig({ ...config, pushPrompt: e.target.value }),
            placeholder: '推送到会话时附带的英文指令（指导该会话 agent 如何使用这些论文）',
          })),
        h('div', { className: 'arxiv-row' },
          h('span', { className: 'arxiv-label' }, '研究背景'),
          h('textarea', {
            className: 'arxiv-textarea', value: config.researchContext ?? '',
            onChange: (e) => setConfig({ ...config, researchContext: e.target.value }),
            placeholder: '默认 research_context：描述当前研究方向/阶段，用于筛选偏好（也可编辑 ~/.dsh-arxiv-inspiration/profile.md）',
          })),
        error ? h('div', { className: 'arxiv-error' }, error) : null,
        h('div', { className: 'arxiv-row' },
          h('button', { className: 'arxiv-btn arxiv-btn-ghost', disabled: !dirty || saving, onClick: onSave, type: 'button' },
            saving ? '保存中…' : '保存配置')),
      );
    }

    /** UTC ISO string → "YYYY-MM-DD HH:mm" in UTC+8. */
    function utc8fmt(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    }
    const WEEKDAY_CN = {
      monday: '周一', tuesday: '周二', wednesday: '周三', thursday: '周四',
      friday: '周五', saturday: '周六', sunday: '周日',
    };

    function SurveyCard({ survey, sessions, onPushed }) {
      const [open, setOpen] = useState(false);
      const [sessionId, setSessionId] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [feedback, setFeedback] = useState(survey.feedback ?? {});
      const [savedNote, setSavedNote] = useState({});
      const result = survey.result;

      const sendFeedback = async (paper, value) => {
        const { arxiv_id: arxivId, title } = paper;
        setFeedback((prev) => ({ ...prev, [arxivId]: value }));
        setSavedNote((prev) => ({ ...prev, [arxivId]: 'saving' }));
        try {
          const reply = await api(`/surveys/${survey.id}/feedback`, {
            method: 'POST',
            body: { arxivId, feedback: value, title },
          });
          const note = value === 'interested'
            ? (reply.interest_added ? '已记录 ✓ 已加入兴趣库' : '已记录 ✓')
            : value === 'not_interested'
              ? '已记录 ✓ 下次调研将温和降权'
              : '已记录 ✓';
          setSavedNote((prev) => ({ ...prev, [arxivId]: note }));
          setTimeout(() => setSavedNote((prev) => {
            const next = { ...prev };
            delete next[arxivId];
            return next;
          }), 3000);
        } catch (e) {
          setSavedNote((prev) => ({ ...prev, [arxivId]: '保存失败 ✗' }));
          setError(e.message);
        }
      };
      const push = async (mode) => {
        if (!sessionId) return;
        setBusy(true); setError('');
        try {
          await api(`/surveys/${survey.id}/push`, { method: 'POST', body: { sessionId, mode } });
          onPushed();
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: 'arxiv-survey' },
        h('div', { className: 'arxiv-row', style: { justifyContent: 'space-between' } },
          h('div', { className: 'arxiv-row' },
            h('span', { className: 'arxiv-badge', 'data-s': survey.status }, survey.status),
            h('span', { className: 'arxiv-meta' },
              `${utc8fmt(survey.created_at)} · ` +
              `${(survey.request?.weekdays ?? []).map((d) => WEEKDAY_CN[d] ?? d).join('/')} · ` +
              (result
                ? `抓取 ${result.fetched_count ?? '-'}` +
                  (result.carryover_count ? ` + 回捞 ${result.carryover_count}` : '') +
                  ` → 候选 ${result.candidate_count ?? '-'} → 推荐 ${result.recommended?.length ?? 0} 篇` +
                  (result.push_limits
                    ? `（预算 ${result.push_limits.maxPush}/${result.push_limits.pushCount}）`
                    : '')
                : '')),
            result?.recall ? h('span', { className: 'arxiv-meta' },
              `召回：关键词 ${result.recall.keyword_lane} / 语义 ${result.recall.semantic_lane}` +
              ` · LLM ${result.recall.rank_batches} 批 ≈ ${Math.round((result.recall.estimated_tokens ?? 0) / 100) / 10}k tokens` +
              (result.recall.hybrid ? ' · RRF' : ' · 直取')) : null),
          h('div', { className: 'arxiv-row' },
            result?.recommended?.length
              ? h('button', { className: 'arxiv-fb', type: 'button', onClick: () => setOpen(!open) },
                  open ? '收起' : '查看结果')
              : null)),
        survey.status === 'running' ? h('span', { className: 'arxiv-meta' }, '调研进行中，请稍候刷新…') : null,
        survey.status_detail ? h('div', { className: 'arxiv-error' }, survey.status_detail) : null,
        open && result ? h('div', null,
          // One block per recommended paper: bilingual title + abstract,
          // Chinese reason/inspiration/action, and its feedback buttons.
          (result.recommended ?? []).map((p, i) =>
            h('div', { key: p.arxiv_id, className: 'arxiv-paper', style: { marginTop: i === 0 ? 4 : 10 } },
              h('a', { href: p.url, target: '_blank', rel: 'noreferrer', className: 'arxiv-paper-title' },
                `${i + 1}. ${p.title}`),
              p.title_zh ? h('div', { className: 'arxiv-title-zh' }, p.title_zh) : null,
              h('div', { className: 'arxiv-meta' },
                `${(p.categories || []).join(', ')} · 相关度 ${p.score ?? '-'}/40 · ${p.arxiv_id}`),
              h('div', { className: 'arxiv-quote' }, p.abstract),
              p.abstract_zh
                ? h('div', { className: 'arxiv-quote arxiv-quote-zh' }, p.abstract_zh)
                : h('div', { className: 'arxiv-meta' }, '（中文摘要缺失）'),
              p.reason ? h('div', { className: 'arxiv-abs' }, `推荐理由：${p.reason}`) : null,
              p.inspiration ? h('div', { className: 'arxiv-abs' }, `💡 启发：${p.inspiration}`) : null,
              p.suggested_action ? h('div', { className: 'arxiv-abs' }, `▶ 建议行动：${p.suggested_action}`) : null,
              p.pdf_analysis_summary || p.pdf_analysis
                ? h(AnalysisBlock, { arxivId: p.arxiv_id, summary: p.pdf_analysis_summary ?? '' })
                : null,
              h('div', { className: 'arxiv-row', style: { marginTop: 4 } },
                h('button', { className: 'arxiv-fb', 'data-on': String(feedback[p.arxiv_id] === 'interested'), type: 'button', onClick: () => sendFeedback(p, 'interested') }, '👍 感兴趣'),
                h('button', { className: 'arxiv-fb', 'data-on': String(feedback[p.arxiv_id] === 'read'), type: 'button', onClick: () => sendFeedback(p, 'read') }, '📖 已读'),
                h('button', { className: 'arxiv-fb', 'data-on': String(feedback[p.arxiv_id] === 'not_interested'), type: 'button', onClick: () => sendFeedback(p, 'not_interested') }, '👎 不感兴趣'),
                savedNote[p.arxiv_id]
                  ? h('span', { className: 'arxiv-meta' }, savedNote[p.arxiv_id] === 'saving' ? '记录中…' : savedNote[p.arxiv_id])
                  : null))),
          h('div', { className: 'arxiv-row', style: { marginTop: 8 } },
            h('select', {
              className: 'arxiv-select', value: sessionId,
              onChange: (e) => setSessionId(e.target.value),
            },
              h('option', { value: '' }, '选择目标对话…'),
              sessions.map((s) =>
                h('option', { key: s.id, value: s.id }, `${String(s.title).slice(0, 40)} (${s.id.slice(0, 8)})`))),
            h('button', {
              className: 'arxiv-btn arxiv-btn-ghost', disabled: !sessionId || busy, type: 'button',
              onClick: () => push('agent'), title: '注入英文论文列表（标题+摘要+链接，可配置篇数）+ 提示词，供该会话 agent 作为研究参考',
            }, busy ? '注入中…' : '🤖 注入论文列表（给 agent）')),
        ) : null,
        error ? h('div', { className: 'arxiv-error' }, error) : null,
      );
    }

    function Page() {
      ensureStyleTag();
      const [config, setConfig] = useState(null);
      const [savedConfig, setSavedConfig] = useState(null);
      const [saving, setSaving] = useState(false);
      const [configError, setConfigError] = useState('');
      const [surveys, setSurveys] = useState([]);
      const [sessions, setSessions] = useState([]);
      const [modelCatalog, setModelCatalog] = useState(null);
      const [starting, setStarting] = useState(false);
      const [startError, setStartError] = useState('');
      const [tab, setTab] = useState('survey');
      const [library, setLibrary] = useState(null);
      const onLoadLibrary = setLibrary;
      const timerRef = useRef(null);

      const refresh = useCallback(async () => {
        try {
          const [cfg, list, sess, models] = await Promise.all([
            api('/config'),
            api('/surveys'),
            api('/sessions'),
            api('/models'),
          ]);
          setConfig((prev) => prev ?? cfg);
          setSavedConfig((prev) => prev ?? cfg);
          setSurveys(list);
          setSessions(sess.sessions ?? []);
          setModelCatalog(models);
        } catch {
          /* host API not reachable yet */
        }
      }, []);

      useEffect(() => {
        void refresh();
        timerRef.current = setInterval(refresh, 5000);
        return () => clearInterval(timerRef.current);
      }, [refresh]);

      const save = async () => {
        setSaving(true); setConfigError('');
        try {
          const next = await api('/config', { method: 'PUT', body: config });
          setConfig(next); setSavedConfig(next);
        } catch (e) {
          setConfigError(e.message);
        } finally {
          setSaving(false);
        }
      };

      const start = async () => {
        setStarting(true); setStartError('');
        try {
          await api('/surveys', { method: 'POST', body: {} });
          await refresh();
        } catch (e) {
          setStartError(e.message);
        } finally {
          setStarting(false);
        }
      };

      if (!config) {
        return h('div', { className: 'arxiv-page' },
          h('div', { className: 'arxiv-sub' }, '加载中… / loading'));
      }
      const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig);
      const running = surveys.some((s) => s.status === 'running');

      return h('div', { className: 'arxiv-page' },
        h('div', { className: 'arxiv-row', style: { gap: 6 } },
          h('button', { className: 'arxiv-chip', 'data-on': String(tab === 'survey'), type: 'button', onClick: () => setTab('survey') }, '调研'),
          h('button', { className: 'arxiv-chip', 'data-on': String(tab === 'library'), type: 'button', onClick: () => setTab('library') }, '论文库'),
          tab === 'library'
            ? h('span', { className: 'arxiv-meta' }, `共 ${library?.total ?? '…'} 篇（历次调研全量入库）`)
            : null),
        tab === 'library'
          ? h(LibraryTab, { library, onLoadLibrary })
          : h('div', null,
              h(ProfileCard),
              h(ConfigForm, {
                config, setConfig, dirty, onSave: save, saving, error: configError,
                modelCatalog, defaultRoute: modelCatalog?.default ?? null,
              }),
              h('div', { className: 'arxiv-card' },
                h('div', { className: 'arxiv-row', style: { justifyContent: 'space-between' } },
                  h('div', null,
                    h('h3', { className: 'arxiv-title', style: { margin: 0 } }, '调研 / Surveys'),
                    h('span', { className: 'arxiv-sub' },
                      '使用左侧保存的默认配置抓取过去 7 天论文并筛选。结果保存于此，可推送摘要到任意对话。')),
                  h('button', { className: 'arxiv-btn', disabled: starting || running, onClick: start, type: 'button' },
                    starting ? '启动中…' : running ? '调研进行中…' : '启动调研')),
                startError ? h('div', { className: 'arxiv-error' }, startError) : null,
                surveys.length === 0
                  ? h('span', { className: 'arxiv-sub' }, '还没有调研记录。点击「启动调研」开始。')
                  : surveys.map((s) => h(SurveyCard, { key: s.id, survey: s, sessions, onPushed: refresh })),
              )),
        h('div', { className: 'arxiv-sub' },
          '知识库位于 ~/.dsh-arxiv-inspiration/（papers.jsonl 论文库、profile.md 画像、interests.jsonl 兴趣、feedback.jsonl 反馈）。反馈会影响后续筛选，全文档案在 fulltext/。'),
      );
    }

    /** Paper-library browser tab: search + filters over papers.jsonl. */
    function LibraryTab({ library, onLoadLibrary }) {
      const [query, setQuery] = useState('');
      const [semantic, setSemantic] = useState(false);
      const [feedback, setFeedback] = useState('');
      const [expanded, setExpanded] = useState(null);
      const [error, setError] = useState('');
      const [addId, setAddId] = useState('');
      const [addNoteMsg, setAddNoteMsg] = useState('');

      const addPaper = async () => {
        if (!addId.trim()) return;
        setAddNoteMsg('添加中…');
        try {
          const reply = await api('/papers', {
            method: 'POST',
            body: { arxiv_id: addId, feedback: 'interested' },
          });
          setAddNoteMsg((reply.added_new ? '已入库 ✓ ' : '已在库中 ✓ ') + reply.paper.title);
          setAddId('');
          void search();
        } catch (e) {
          setAddNoteMsg('添加失败：' + e.message);
        }
      };

      const search = async () => {
        setError('');
        try {
          const params = new URLSearchParams({ query, feedback, semantic: String(semantic), limit: '50' });
          onLoadLibrary(await api(`/papers?${params}`));
        } catch (e) {
          setError(e.message);
        }
      };
      useEffect(() => { void search(); }, []); // initial listing

      const papers = library?.papers ?? [];
      return h('div', { className: 'arxiv-card' },
        h('div', { className: 'arxiv-row' },
          h('input', {
            className: 'arxiv-input', value: query,
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') void search(); },
            placeholder: '搜索标题/摘要关键词…',
          }),
          h('select', {
            className: 'arxiv-select', value: feedback,
            onChange: (e) => { setFeedback(e.target.value); setTimeout(search, 0); },
          },
            h('option', { value: '' }, '全部反馈'),
            h('option', { value: 'interested' }, '👍 感兴趣'),
            h('option', { value: 'read' }, '📖 已读'),
            h('option', { value: 'not_interested' }, '👎 不感兴趣')),
          h('button', {
            className: 'arxiv-chip', 'data-on': String(semantic), type: 'button',
            role: 'switch', 'aria-checked': String(semantic),
            onClick: () => setSemantic(!semantic),
            title: '语义检索（向量索引，不可用时自动回退关键词）',
          }, '语义检索'),
          h('button', { className: 'arxiv-btn', type: 'button', onClick: search }, '搜索')),
        h('div', { className: 'arxiv-row', style: { marginTop: 6 } },
          h('input', {
            className: 'arxiv-input', value: addId,
            onChange: (e) => setAddId(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') void addPaper(); },
            placeholder: '手动添加论文：arXiv ID 或 abs 链接（自动抓取元数据，默认标记 👍）',
          }),
          h('button', { className: 'arxiv-fb', type: 'button', onClick: addPaper }, '＋ 添加'),
          addNoteMsg ? h('span', { className: 'arxiv-meta' }, addNoteMsg) : null),
        error ? h('div', { className: 'arxiv-error' }, error) : null,
        papers.length === 0
          ? h('span', { className: 'arxiv-sub' }, '没有匹配的论文。')
          : papers.map((p) =>
              h('div', { key: p.arxiv_id, className: 'arxiv-paper' },
                h('a', { href: p.url, target: '_blank', rel: 'noreferrer', className: 'arxiv-paper-title' }, p.title),
                p.title_zh ? h('div', { className: 'arxiv-title-zh' }, p.title_zh) : null,
                h('div', { className: 'arxiv-row', style: { justifyContent: 'space-between' } },
                  h('span', { className: 'arxiv-meta' },
                    `${(p.categories ?? []).join(', ')} · ${p.arxiv_id} · ` +
                    `首见 ${String(p.first_seen ?? '').slice(0, 10)}` +
                    (p.scores?.length ? ` · 最高分 ${Math.max(...p.scores.map((s) => s.total ?? 0))}/40` : '') +
                    (p.feedback ? ` · ${p.feedback === 'interested' ? '👍' : p.feedback === 'read' ? '📖' : '👎'}` : '') +
                    (p.pdf_analysis || p.has_analysis ? ' · 📄已深读' : '')),
                  h('button', { className: 'arxiv-fb', type: 'button', onClick: () => setExpanded(expanded === p.arxiv_id ? null : p.arxiv_id) },
                    expanded === p.arxiv_id ? '收起' : '摘要')),
                expanded === p.arxiv_id ? h('div', null,
                  h('div', { className: 'arxiv-quote' }, p.abstract),
                  p.abstract_zh ? h('div', { className: 'arxiv-quote arxiv-quote-zh' }, p.abstract_zh) : null,
                  p.pdf_analysis || p.has_analysis ? h(AnalysisBlock, { arxivId: p.arxiv_id, summary: p.pdf_analysis_summary }) : null,
                  h(PaperNotes, { arxivId: p.arxiv_id })) : null)),
      );
    }

    /**
     * Deep-read block (C-2): Chinese bullet summary inline; the full md note
     * opens in its own viewer window (server-rendered page), not in the card.
     */
    function AnalysisBlock({ arxivId, summary }) {
      const openViewer = () => {
        window.open(
          `/arxiv-inspiration/api/papers/${encodeURIComponent(arxivId)}/analysis/view`,
          '_blank',
          'noopener',
        );
      };
      return h('div', { className: 'arxiv-abs' },
        h('div', { className: 'arxiv-deepread' },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '📄 深读要点'),
          (summary ?? '').split('\n').filter(Boolean).map((line, i) =>
            h('div', { key: i, style: { paddingLeft: 8 } }, line)),
          h('button', { className: 'arxiv-fb', type: 'button', onClick: openViewer },
            '📄 查看完整深读笔记 ↗')));
    }

    /** Notes timeline + add-note input for one paper (P3-9). */
    function PaperNotes({ arxivId }) {
      const [notes, setNotes] = useState(null);
      const [text, setText] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');

      const load = useCallback(async () => {
        try {
          const reply = await api(`/papers/${encodeURIComponent(arxivId)}/notes`);
          setNotes(reply.notes ?? []);
        } catch (e) {
          setError(e.message);
        }
      }, [arxivId]);
      useEffect(() => { void load(); }, [load]);

      const submit = async () => {
        if (!text.trim()) return;
        setBusy(true); setError('');
        try {
          await api(`/papers/${encodeURIComponent(arxivId)}/notes`, { method: 'POST', body: { text } });
          setText('');
          await load();
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      };

      return h('div', { style: { marginTop: 6 } },
        h('div', { className: 'arxiv-meta' }, '笔记（你的笔记会注入后续调研的推荐提示，agent 的深读结论也会沉淀在此）：'),
        (notes ?? []).map((n) =>
          h('div', { key: n.at, className: 'arxiv-quote' },
            `${n.author === 'agent' ? '🤖' : '👤'} ${String(n.at).slice(0, 16).replace('T', ' ')} — ${n.text}`)),
        notes === null ? h('span', { className: 'arxiv-meta' }, '加载笔记…') : null,
        h('div', { className: 'arxiv-row', style: { marginTop: 4 } },
          h('input', {
            className: 'arxiv-input', value: text,
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') void submit(); },
            placeholder: '添加笔记…',
          }),
          h('button', { className: 'arxiv-fb', type: 'button', disabled: busy || !text.trim(), onClick: submit }, busy ? '保存中…' : '记笔记')),
        error ? h('div', { className: 'arxiv-error' }, error) : null);
    }

    /** Research profile card: current profile + revision draft workflow (P2-6). */
    function ProfileCard() {
      const [data, setData] = useState(null);
      const [editing, setEditing] = useState(null); // draft text being edited
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [showCurrent, setShowCurrent] = useState(false);

      const load = useCallback(async () => {
        try { setData(await api('/profile')); } catch (e) { setError(e.message); }
      }, [1]);
      useEffect(() => { void load(); }, [load]);

      const generate = async () => {
        setBusy(true); setError('');
        try { await api('/profile/draft', { method: 'POST', body: {} }); await load(); }
        catch (e) { setError(e.message); } finally { setBusy(false); }
      };
      const adopt = async (text) => {
        setBusy(true); setError('');
        try { await api('/profile/adopt', { method: 'POST', body: { text } }); setEditing(null); await load(); }
        catch (e) { setError(e.message); } finally { setBusy(false); }
      };
      const discard = async () => {
        setBusy(true); setError('');
        try { await api('/profile/discard', { method: 'POST', body: {} }); setEditing(null); await load(); }
        catch (e) { setError(e.message); } finally { setBusy(false); }
      };

      if (!data) return null;
      const draft = data.draft?.profile_draft_md ? data.draft : null;
      return h('div', { className: 'arxiv-card' },
        h('div', { className: 'arxiv-row', style: { justifyContent: 'space-between' } },
          h('div', null,
            h('h3', { className: 'arxiv-title', style: { margin: 0 } }, '研究画像 / Profile'),
            h('span', { className: 'arxiv-sub' },
              `驱动论文筛选。自上次修订以来新增反馈 ${data.new_feedback_since_revision} 条。`)),
          h('div', { className: 'arxiv-row' },
            h('button', { className: 'arxiv-fb', type: 'button', onClick: () => setShowCurrent(!showCurrent) },
              showCurrent ? '收起当前画像' : '查看当前画像'),
            h('button', { className: 'arxiv-btn', type: 'button', disabled: busy, onClick: generate },
              busy && !draft ? '生成中…' : draft ? '重新生成修订稿' : '生成画像修订稿'))),
        showCurrent ? h('div', { className: 'arxiv-quote' }, data.profile || '(空)') : null,
        draft ? h('div', null,
          h('div', { className: 'arxiv-meta' }, `修订稿（${String(draft.generated_at ?? '').slice(0, 16).replace('T', ' ')}，依据 👍${draft.evidence?.interested ?? 0} / 👎${draft.evidence?.not_interested ?? 0} 条反馈）：`),
          h('div', { className: 'arxiv-quote' }, draft.changelog ? `变更说明：${draft.changelog}` : ''),
          editing !== null
            ? h('textarea', { className: 'arxiv-textarea', value: editing, onChange: (e) => setEditing(e.target.value) })
            : h('div', { className: 'arxiv-quote', style: { whiteSpace: 'pre-wrap' } }, draft.profile_draft_md),
          h('div', { className: 'arxiv-row', style: { marginTop: 6 } },
            h('button', { className: 'arxiv-btn', type: 'button', disabled: busy,
              onClick: () => adopt(editing !== null ? editing : draft.profile_draft_md) }, '采纳（旧版自动存档）'),
            editing === null
              ? h('button', { className: 'arxiv-fb', type: 'button', onClick: () => setEditing(draft.profile_draft_md) }, '编辑后采纳')
              : h('button', { className: 'arxiv-fb', type: 'button', onClick: () => setEditing(null) }, '取消编辑'),
            h('button', { className: 'arxiv-fb', type: 'button', disabled: busy, onClick: discard }, '放弃'))) : null,
        error ? h('div', { className: 'arxiv-error' }, error) : null);
    }

    // Must equal the package name: the client-modules entry id is the manifest
    // name, and __ModuleLoader__.load({id}) throws "could not load" on a mismatch.
    const MODULE_ID = 'dsh-arxiv-inspiration';
    const STYLE_ID = `${MODULE_ID}/styles.css`;

    /** Install our stylesheet as an owned, tagged <style> (idempotent). */
    function ensureStyleTag() {
      if (typeof document === 'undefined') return;
      // Tag ownership explicitly: dsh-client-modules claims every UNtagged
      // <style> for whichever module materializes next, and later removes
      // claimed tags on that module's reload, which would silently strip our
      // styles (and would let our own tags be mis-attributed to others).
      if (!document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']')) {
        const tag = document.createElement('style');
        tag.setAttribute('data-plugin-css', STYLE_ID);
        tag.setAttribute('data-plugin', MODULE_ID);
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyleTag();
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'arxiv-inspiration', order: 90, label: 'arXiv Inspiration' },
            Page,
          ),
        );
      },
    };
  },
});
