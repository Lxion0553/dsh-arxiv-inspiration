/**
 * arXiv Inspiration — client half.
 *
 * Full page in the main area via a `sidebar.panellist` button (same pattern
 * as the memory explorer), with the settings.section registration kept as a
 * fallback. Tabs: survey launcher + result browser with per-paper feedback,
 * library, deep-read notes (incl. external agentero paper-reader deep-dives,
 * referenced only), and the push collection.
 * All data flows through the host HTTP API at /arxiv-inspiration/api/*.
 */

window.__ModuleLoader__.load({
  id: 'dsh-arxiv-inspiration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // The platform's own markdown renderer (KaTeX math, tables, footnotes).
    // Guarded: an older shell without the module keeps the unicode fallback.
    /** Bumped whenever client UI changes, so the settings page shows which bundle the browser runs. */
    const BUILD = '0.5.2-ui8-mainfix';
    let MarkdownText = null;
    try {
      MarkdownText = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText ?? null;
    } catch {
      MarkdownText = null;
    }
    const { useState, useEffect, useCallback, useRef } = React;
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
.arxiv-deepread { white-space: normal; }
.arxiv-note { margin-top: 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; max-height: 520px; overflow: auto; white-space: normal; font-size: 13px; }
.arxiv-note :where(h1, h2, h3, h4) { margin: 12px 0 6px; line-height: 1.4; }
.arxiv-note :where(p, li) { white-space: normal; }
.arxiv-note :where(pre, code) { white-space: pre-wrap; word-break: break-word; }
.arxiv-note-pre { white-space: pre-wrap; word-break: break-word; font-size: 11.5px; }
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
.arxiv-notes-layout { display: flex; gap: 14px; margin-top: 10px; align-items: stretch; }
.arxiv-notes-list { width: 280px; flex: none; max-height: calc(100vh - 240px); overflow: auto; display: flex; flex-direction: column; gap: 6px; }
.arxiv-note-item { text-align: left; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 8px 10px; cursor: pointer; font-size: 12px; line-height: 1.5; }
.arxiv-note-item[data-on='true'] { border-color: var(--dsw-alias-brand-primary); }
.arxiv-note-item-title { font-weight: 600; font-size: 12.5px; }
.arxiv-notes-view { flex: 1; min-width: 0; }
.arxiv-note-page { max-height: calc(100vh - 240px); overflow: auto; padding: 4px 2px; white-space: normal; font-size: 14px; line-height: 1.7; }
.arxiv-note-page :where(h1, h2, h3, h4) { margin: 14px 0 6px; line-height: 1.4; }
.arxiv-note-page :where(p, li) { white-space: normal; }
.arxiv-note-page :where(pre, code) { white-space: pre-wrap; word-break: break-word; }
.arxiv-note-page img { max-width: 100%; border-radius: 6px; }
/* The main seat does not scroll itself: the page must own its viewport
 * height (same pattern as the memory explorer) and scroll internally. */
.arxiv-mainwrap { height: calc(100vh - 48px); min-height: 0; display: flex; flex-direction: column; padding: 14px 22px 20px; max-width: 1320px; margin: 0 auto; box-sizing: border-box; }
.arxiv-mainhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; gap: 12px; flex: none; }
.arxiv-mainscroll { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 6px 20px 0; }
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
        Field('自动入清单',
          h('button', {
            className: 'arxiv-chip', 'data-on': String(config.autoCollect !== false), type: 'button',
            onClick: () => setConfig({ ...config, autoCollect: config.autoCollect === false }),
            role: 'switch', 'aria-checked': String(config.autoCollect !== false),
            title: '每次调研完成后，把最终推荐列表自动收进「清单」标签（按 arXiv id 去重；手动移除过的不再自动收）',
          }, config.autoCollect !== false ? '调研推荐自动收集：开' : '调研推荐自动收集：关')),
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
        h('div', { className: 'arxiv-row' },
          h('span', { className: 'arxiv-label' }, 'paper-reader 目录'),
          h('input', {
            className: 'arxiv-input', value: config.agenteroPapersDir ?? '',
            onChange: (e) => setConfig({ ...config, agenteroPapersDir: e.target.value }),
            placeholder: 'agentero paper-reader 笔记库根目录（…/papers/papers），留空关闭；只做路径引用',
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

    /** Library recheck launcher (库内重评): re-evaluate papers.jsonl against
     * the CURRENT profile. Funnel: coarse 0-10 over every candidate → fine
     * ranking of survivors → top picks (full treatment) + worth-a-look tier. */
    function RecheckPanel({ running, onLaunched }) {
      const [open, setOpen] = useState(false);
      const [fullRescan, setFullRescan] = useState(false);
      const [inclRec, setInclRec] = useState(false);
      const [inclPushed, setInclPushed] = useState(false);
      const [since, setSince] = useState('');
      const [until, setUntil] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');

      const chip = (on, set, label, title) => h('button', {
        className: 'arxiv-chip', 'data-on': String(on), type: 'button', title,
        onClick: () => set(!on),
      }, `${on ? '✓ ' : ''}${label}`);

      const launch = async () => {
        setBusy(true); setError('');
        try {
          await api('/surveys', {
            method: 'POST',
            body: {
              mode: 'recheck',
              fullRescan,
              includeRecommended: inclRec,
              includePushed: inclPushed,
              since: since || undefined,
              until: until || undefined,
            },
          });
          setOpen(false);
          onLaunched?.();
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: 'arxiv-card' },
        h('div', { className: 'arxiv-row', style: { justifyContent: 'space-between' } },
          h('div', null,
            h('h3', { className: 'arxiv-title', style: { margin: 0 } }, '♻️ 库内重评 / Library Recheck'),
            h('span', { className: 'arxiv-sub' },
              '画像或研究背景变化后，按当前画像重评论文库存量论文（调研只能看过去 7 天，重评不受此限）。')),
          h('button', { className: 'arxiv-btn arxiv-btn-ghost', type: 'button', onClick: () => setOpen(!open) },
            open ? '收起' : '重评论文库')),
        open
          ? h('div', { style: { marginTop: 8 } },
              h('div', { className: 'arxiv-row', style: { flexWrap: 'wrap' } },
                chip(fullRescan, setFullRescan, '全量重扫', '忽略水位线，重评所有论文（默认只评从未重评过的）'),
                chip(inclRec, setInclRec, '含已推荐', '包含过去调研已推荐过的论文（默认排除）'),
                chip(inclPushed, setInclPushed, '含已推送', '包含已推送给会话的论文（默认排除）'),
                h('span', { className: 'arxiv-meta', style: { alignSelf: 'center' } }, '首次入库日期（可选）'),
                h('input', { type: 'date', value: since, onChange: (e) => setSince(e.target.value), className: 'arxiv-input', style: { width: 140 } }),
                h('span', { className: 'arxiv-meta' }, '→'),
                h('input', { type: 'date', value: until, onChange: (e) => setUntil(e.target.value), className: 'arxiv-input', style: { width: 140 } })),
              h('div', { className: 'arxiv-meta', style: { marginTop: 4 } },
                '漏斗：粗筛（每篇 0-10 分写回论文库）→ 精排 top 80 → 推荐 ~5 篇（全待遇）+ 值得一看 ≤30 篇。排除：不感兴趣反馈永远跳过。'),
              h('div', { className: 'arxiv-row', style: { marginTop: 6 } },
                h('button', { className: 'arxiv-btn', disabled: busy || running, type: 'button', onClick: launch },
                  busy ? '启动中…' : running ? '有任务进行中…' : '♻️ 启动重评')),
              error ? h('div', { className: 'arxiv-error' }, error) : null)
          : null);
    }

    const RECHECK_STAGE_CN = { coarse: '粗筛', fine: '精排', translate: '翻译', done: '完成' };

    function SurveyCard({ survey, sessions, onPushed, collectionIds, onCollectionChange, onOpenNotes }) {
      const [open, setOpen] = useState(false);
      const [sessionId, setSessionId] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [feedback, setFeedback] = useState(survey.feedback ?? {});
      const [savedNote, setSavedNote] = useState({});
      const [worthOpen, setWorthOpen] = useState(false);
      const result = survey.result;
      const isRecheck = survey.request?.type === 'recheck' || result?.type === 'recheck';

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
            isRecheck ? h('span', { className: 'arxiv-chip', 'data-on': 'true', type: 'button', style: { cursor: 'default' } }, '♻️ 库内重评') : null,
            h('span', { className: 'arxiv-meta' },
              isRecheck
                ? `${utc8fmt(survey.created_at)} · ` +
                  (result
                    ? `候选 ${result.candidate_count ?? '-'} → 粗筛存活 ${result.fine_pool ?? '-'} → 推荐 ${result.recommended?.length ?? 0} + 值得一看 ${result.worth_a_look?.length ?? 0} 篇`
                    : '按当前画像重评论文库')
                : `${utc8fmt(survey.created_at)} · ` +
                  `${(survey.request?.weekdays ?? []).map((d) => WEEKDAY_CN[d] ?? d).join('/')} · ` +
                  (result
                    ? `抓取 ${result.fetched_count ?? '-'}` +
                      (result.carryover_count ? ` + 回捞 ${result.carryover_count}` : '') +
                      ` → 候选 ${result.candidate_count ?? '-'} → 推荐 ${result.recommended?.length ?? 0} 篇` +
                      (result.push_limits
                        ? `（预算 ${result.push_limits.maxPush}/${result.push_limits.pushCount}）`
                        : '')
                    : '')),
            !isRecheck && result?.recall ? h('span', { className: 'arxiv-meta' },
              `召回：关键词 ${result.recall.keyword_lane} / 语义 ${result.recall.semantic_lane}` +
              ` · LLM ${result.recall.rank_batches} 批 ≈ ${Math.round((result.recall.estimated_tokens ?? 0) / 100) / 10}k tokens` +
              (result.recall.hybrid ? ' · RRF' : ' · 直取')) : null,
            isRecheck && result?.coarse_batches ? h('span', { className: 'arxiv-meta' }, `粗筛 ${result.coarse_batches} 批`) : null),
          h('div', { className: 'arxiv-row' },
            result?.recommended?.length
              ? h('button', { className: 'arxiv-fb', type: 'button', onClick: () => setOpen(!open) },
                  open ? '收起' : '查看结果')
              : null)),
        survey.status === 'running'
          ? h('span', { className: 'arxiv-meta' },
              survey.progress
                ? `重评进行中：${RECHECK_STAGE_CN[survey.progress.stage] ?? survey.progress.stage} ${survey.progress.done}/${survey.progress.total}${survey.progress.stage === 'coarse' ? ' 批' : ''}，请稍候刷新…`
                : '调研进行中，请稍候刷新…')
          : null,
        survey.status_detail ? h('div', { className: 'arxiv-error' }, survey.status_detail) : null,
        open && result ? h('div', null,
          // One block per recommended paper: bilingual title + abstract,
          // Chinese reason/inspiration/action, and its feedback buttons.
          (result.recommended ?? []).map((p, i) =>
            h('div', { key: p.arxiv_id, className: 'arxiv-paper', style: { marginTop: i === 0 ? 4 : 10 } },
              h('a', { href: p.url, target: '_blank', rel: 'noreferrer', className: 'arxiv-paper-title' },
                `${i + 1}. ${p.title}`),
              p.title_zh ? h('div', { className: 'arxiv-title-zh' }, mathToUnicode(p.title_zh)) : null,
              h('div', { className: 'arxiv-meta' },
                `${(p.categories || []).join(', ')} · 相关度 ${p.score ?? '-'}/40 · ${p.arxiv_id}`),
              h('div', { className: 'arxiv-quote' }, mathToUnicode(p.abstract)),
              p.abstract_zh
                ? h('div', { className: 'arxiv-quote arxiv-quote-zh' }, mathToUnicode(p.abstract_zh))
                : h('div', { className: 'arxiv-meta' }, '（中文摘要缺失）'),
              p.reason ? h('div', { className: 'arxiv-abs' }, `推荐理由：${mathToUnicode(p.reason)}`) : null,
              p.inspiration ? h('div', { className: 'arxiv-abs' }, `💡 启发：${mathToUnicode(p.inspiration)}`) : null,
              p.suggested_action ? h('div', { className: 'arxiv-abs' }, `▶ 建议行动：${mathToUnicode(p.suggested_action)}`) : null,
              p.pdf_analysis_summary || p.pdf_analysis
                ? h(AnalysisBlock, {
                    arxivId: p.arxiv_id, summary: p.pdf_analysis_summary ?? '',
                    analysisPath: p.analysis_path,
                    onOpenNotes: onOpenNotes ? () => onOpenNotes(p.arxiv_id, 'mine') : undefined,
                  })
                : null,
              h('div', { className: 'arxiv-row', style: { marginTop: 4 } },
                h('button', {
                  className: 'arxiv-fb', 'data-on': String(collectionIds?.has(p.arxiv_id) ?? false), type: 'button',
                  onClick: async () => {
                    try {
                      await api('/collection', { method: 'POST', body: { arxiv_id: p.arxiv_id, title: p.title, note: p.reason ?? '' } });
                      onCollectionChange?.();
                    } catch (e) { setError(e.message); }
                  },
                  title: '加入推送清单：攒够一批后在「清单」标签一次性注入给某个会话',
                }, collectionIds?.has(p.arxiv_id) ? '✓ 已在清单' : '＋ 清单'),
                h('button', { className: 'arxiv-fb', 'data-on': String(feedback[p.arxiv_id] === 'interested'), type: 'button', onClick: () => sendFeedback(p, 'interested') }, '👍 感兴趣'),
                h('button', { className: 'arxiv-fb', 'data-on': String(feedback[p.arxiv_id] === 'read'), type: 'button', onClick: () => sendFeedback(p, 'read') }, '📖 已读'),
                h('button', { className: 'arxiv-fb', 'data-on': String(feedback[p.arxiv_id] === 'not_interested'), type: 'button', onClick: () => sendFeedback(p, 'not_interested') }, '👎 不感兴趣'),
                savedNote[p.arxiv_id]
                  ? h('span', { className: 'arxiv-meta' }, savedNote[p.arxiv_id] === 'saving' ? '记录中…' : savedNote[p.arxiv_id])
                  : null))),
          // Worth-a-look tier (库内重评): fine-ranked papers right below the
          // picks — English title + one-line reason + quick add to collection.
          result.worth_a_look?.length
            ? h('div', { style: { marginTop: 10 } },
                h('button', {
                  className: 'arxiv-chip', 'data-on': String(worthOpen), type: 'button',
                  onClick: () => setWorthOpen(!worthOpen),
                  title: '精排通过但未进推荐的论文：一句话理由，可一键加入清单',
                }, `${worthOpen ? '收起' : '展开'} 值得一看 (${result.worth_a_look.length})`),
                worthOpen
                  ? result.worth_a_look.map((p, i) =>
                      h('div', { key: p.arxiv_id, className: 'arxiv-row', style: { marginTop: 6, alignItems: 'flex-start' } },
                        h('span', { className: 'arxiv-meta', style: { minWidth: 26 } }, `${i + 1}.`),
                        h('div', { style: { flex: 1 } },
                          h('a', { href: p.url, target: '_blank', rel: 'noreferrer', className: 'arxiv-paper-title', style: { fontSize: 13 } },
                            p.title),
                          h('div', { className: 'arxiv-meta' },
                            `${p.coarse_score ?? '-'}/10 · ${p.arxiv_id}`),
                          p.reason ? h('div', { className: 'arxiv-abs', style: { marginTop: 2 } }, mathToUnicode(p.reason)) : null),
                        h('button', {
                          className: 'arxiv-fb', 'data-on': String(collectionIds?.has(p.arxiv_id) ?? false), type: 'button',
                          onClick: async () => {
                            try {
                              await api('/collection', { method: 'POST', body: { arxiv_id: p.arxiv_id, title: p.title, note: p.reason ?? '' } });
                              onCollectionChange?.();
                            } catch (e) { setError(e.message); }
                          },
                          title: '加入推送清单（不自动收集，手动加）',
                        }, collectionIds?.has(p.arxiv_id) ? '✓ 已在清单' : '＋ 清单')))
                  : null)
            : null,
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
      const [notesView, setNotesView] = useState(null);
      const [library, setLibrary] = useState(null);
      const [collection, setCollection] = useState(null);
      const onLoadLibrary = setLibrary;
      const collIds = new Set((collection?.items ?? []).map((i) => i.arxiv_id));
      const timerRef = useRef(null);
      // Jump to the notes tab with one paper preselected (used by the cards'
      // 「⤢ 全宽阅读」 buttons and by the library rows).
      const openNotes = (arxivId, source = 'mine') => {
        setNotesView({ arxivId, source });
        setTab('notes');
      };

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
          const coll = await api('/collection').catch(() => null);
          if (coll) setCollection(coll);
        } catch {
          /* host API not reachable yet */
        }
      }, []);

      const refreshCollection = useCallback(async () => {
        try {
          setCollection(await api('/collection'));
        } catch {
          /* keep the previous snapshot */
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
          h('button', { className: 'arxiv-chip', 'data-on': String(tab === 'notes'), type: 'button', onClick: () => setTab('notes') }, '深读笔记'),
          h('button', { className: 'arxiv-chip', 'data-on': String(tab === 'collection'), type: 'button', onClick: () => setTab('collection') },
            `清单${collection ? ` (${collection.total})` : ''}`),
          tab === 'library'
            ? h('span', { className: 'arxiv-meta' }, `共 ${library?.total ?? '…'} 篇（历次调研全量入库）`)
            : null,
          h('span', { className: 'arxiv-meta', style: { marginLeft: 'auto', opacity: 0.6 } },
            `build ${BUILD}${MarkdownText ? '' : ' · 无 md 渲染器'}`)),
        tab === 'notes'
          ? h(NotesTab, { view: notesView, setView: setNotesView })
          : tab === 'library'
          ? h(LibraryTab, { library, onLoadLibrary, collectionIds: collIds, onCollectionChange: refreshCollection, onOpenNotes: openNotes })
          : tab === 'collection'
            ? h(CollectionTab, { collection, sessions, refreshCollection })
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
                  : surveys.map((s) => h(SurveyCard, { key: s.id, survey: s, sessions, onPushed: refresh, collectionIds: collIds, onCollectionChange: refreshCollection, onOpenNotes: openNotes })),
              ),
              h(RecheckPanel, { running, onLaunched: refresh })),
        h('div', { className: 'arxiv-sub' },
          '知识库位于 ~/.dsh-arxiv-inspiration/（papers.jsonl 论文库、profile.md 画像、interests.jsonl 兴趣、feedback.jsonl 反馈）。反馈会影响后续筛选，全文档案在 fulltext/。'),
      );
    }

    /** Paper-library browser tab: search + filters over papers.jsonl. */
    function LibraryTab({ library, onLoadLibrary, collectionIds, onCollectionChange, onOpenNotes }) {
      const [query, setQuery] = useState('');
      const [semantic, setSemantic] = useState(false);
      const [feedback, setFeedback] = useState('');
      const [sort, setSort] = useState('deepread'); // 论文库默认已深读优先
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

      const search = async (sortOverride) => {
        // onClick passes a synthetic event; only accept string overrides.
        const s = typeof sortOverride === 'string' ? sortOverride : sort;
        setError('');
        try {
          const params = new URLSearchParams({ query, feedback, sort: s, semantic: String(semantic), limit: '50' });
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
          h('select', {
            className: 'arxiv-select', value: sort,
            onChange: (e) => { const next = e.target.value; setSort(next); setTimeout(() => search(next), 0); },
            title: '排序方式',
          },
            h('option', { value: 'recent' }, '最新入库'),
            h('option', { value: 'score' }, '最高评分'),
            h('option', { value: 'unjudged' }, '待反馈优先'),
            h('option', { value: 'deepread' }, '深读优先'),
            h('option', { value: 'collection' }, '清单优先')),
          h('button', {
            className: 'arxiv-chip', 'data-on': String(semantic), type: 'button',
            role: 'switch', 'aria-checked': String(semantic),
            onClick: () => setSemantic(!semantic),
            title: '语义检索（向量索引，不可用时自动回退关键词）',
          }, '语义检索'),
          h('button', { className: 'arxiv-btn', type: 'button', onClick: () => search() }, '搜索')),
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
                p.title_zh ? h('div', { className: 'arxiv-title-zh' }, mathToUnicode(p.title_zh)) : null,
                h('div', { className: 'arxiv-row', style: { justifyContent: 'space-between' } },
                  h('span', { className: 'arxiv-meta' },
                    `${(p.categories ?? []).join(', ')} · ${p.arxiv_id} · ` +
                    `首见 ${String(p.first_seen ?? '').slice(0, 10)}` +
                    (p.scores?.length ? ` · 最高分 ${Math.max(...p.scores.map((s) => s.total ?? 0))}/40` : '') +
                    (p.feedback ? ` · ${p.feedback === 'interested' ? '👍' : p.feedback === 'read' ? '📖' : '👎'}` : '') +
                    (p.pdf_analysis || p.has_analysis ? ' · 📄已深读' : '')),
                  h('div', { className: 'arxiv-row' },
                    h('button', {
                      className: 'arxiv-fb', 'data-on': String(collectionIds?.has(p.arxiv_id) ?? false), type: 'button',
                      onClick: async () => {
                        try {
                          await api('/collection', { method: 'POST', body: { arxiv_id: p.arxiv_id, title: p.title } });
                          onCollectionChange?.();
                        } catch (e) { setError(e.message); }
                      },
                      title: '加入推送清单：攒够一批后在「清单」标签一次性注入给某个会话',
                    }, collectionIds?.has(p.arxiv_id) ? '✓ 已在清单' : '＋ 清单'),
                    h('button', { className: 'arxiv-fb', type: 'button', onClick: () => setExpanded(expanded === p.arxiv_id ? null : p.arxiv_id) },
                      expanded === p.arxiv_id ? '收起' : '摘要'))),
                expanded === p.arxiv_id ? h('div', null,
                  h('div', { className: 'arxiv-quote' }, mathToUnicode(p.abstract)),
                  p.abstract_zh ? h('div', { className: 'arxiv-quote arxiv-quote-zh' }, mathToUnicode(p.abstract_zh)) : null,
                  p.pdf_analysis || p.has_analysis ? h(AnalysisBlock, {
                    arxivId: p.arxiv_id, summary: p.pdf_analysis_summary, analysisPath: p.analysis_path,
                    onOpenNotes: onOpenNotes ? () => onOpenNotes(p.arxiv_id, 'mine') : undefined,
                  }) : null,
                  h(PaperNotes, { arxivId: p.arxiv_id })) : null)),
      );
    }

    /**
     * Deep-read block: Chinese bullet summary inline; the full note expands
     * in place via platform MarkdownText (KaTeX).「⤢ 全宽阅读」jumps to the
     * 深读笔记 tab for full-width reading.
     */
    /**
     * Deep-read notes tab: full-width reading page for MY deep-read notes
     * (survey-generated Chinese digests + agent-written notes) and for
     * external agentero paper-reader deep-dives. The latter are referenced
     * only — rendered straight from the external NOTES.md (with image links
     * rewritten to same-origin asset URLs), never merged into our notes.
     */
    function NotesTab({ view, setView }) {
      const [entries, setEntries] = useState(null);
      const [mine, setMine] = useState(undefined); // {md} | {err}
      const [agent, setAgent] = useState(undefined); // {md, path} | {err}
      const [source, setSource] = useState('mine');
      useEffect(() => {
        void (async () => {
          try {
            const r = await api('/papers?sort=deepread&limit=200');
            setEntries((r.papers ?? []).filter((p) => p.has_analysis || p.has_agentero));
          } catch {
            setEntries([]);
          }
        })();
      }, []);
      useEffect(() => {
        setMine(undefined);
        setAgent(undefined);
        if (!view?.arxivId) return undefined;
        const id = view.arxivId;
        let alive = true;
        void (async () => {
          try {
            const r = await api(`/papers/${encodeURIComponent(id)}/analysis`);
            if (alive) setMine({ md: r.markdown ?? '' });
          } catch (e) {
            if (alive) setMine({ err: e.message });
          }
        })();
        void (async () => {
          try {
            const r = await api(`/papers/${encodeURIComponent(id)}/agentero`);
            if (alive) setAgent({ md: r.rendered || r.markdown || '', path: r.path });
          } catch (e) {
            if (alive) setAgent({ err: e.message });
          }
        })();
        setSource(view.source === 'agentero' ? 'agentero' : 'mine');
        return () => { alive = false; };
      }, [view?.arxivId, view?.source]);
      const cur = entries?.find((e) => e.arxiv_id === view?.arxivId);
      const pane = source === 'agentero' ? agent : mine;
      return h('div', { className: 'arxiv-card' },
        h('h3', { className: 'arxiv-title', style: { margin: 0 } }, '深读笔记 / Deep-Read Notes'),
        h('div', { className: 'arxiv-meta' },
          '📄 我的深读（调研生成的中文综合） · 📖 paper-reader 讲解（agentero 外部笔记，含图，只引用不合并）。左侧选择论文，右侧全宽阅读（KaTeX 公式）。'),
        h('div', { className: 'arxiv-notes-layout' },
          h('div', { className: 'arxiv-notes-list' },
            entries === null ? h('div', { className: 'arxiv-sub' }, '加载中… / loading')
              : entries.length === 0 ? h('div', { className: 'arxiv-sub' }, '暂无深读笔记（调研生成的深读会出现在这里）')
                : entries.map((e) => h('button', {
                    key: e.arxiv_id, type: 'button',
                    className: 'arxiv-note-item',
                    'data-on': String(e.arxiv_id === view?.arxivId),
                    onClick: () => setView({ arxivId: e.arxiv_id, source: e.has_analysis ? 'mine' : 'agentero' }),
                  },
                    h('div', { className: 'arxiv-note-item-title' }, e.title_zh || e.title || e.arxiv_id),
                    h('div', { className: 'arxiv-meta' },
                      `${e.arxiv_id} ${e.has_analysis ? '📄' : ''}${e.has_agentero ? '📖' : ''}`)))),
          h('div', { className: 'arxiv-notes-view' },
            !view?.arxivId
              ? h('div', { className: 'arxiv-sub' }, '从左侧选择一篇论文查看笔记。')
              : h('div', null,
                h('div', { className: 'arxiv-row', style: { marginBottom: 8, gap: 6 } },
                  mine && !mine.err
                    ? h('button', { className: 'arxiv-chip', 'data-on': String(source === 'mine'), type: 'button', onClick: () => setSource('mine') }, '📄 我的深读')
                    : null,
                  agent && !agent.err
                    ? h('button', { className: 'arxiv-chip', 'data-on': String(source === 'agentero'), type: 'button', onClick: () => setSource('agentero') }, '📖 paper-reader 讲解')
                    : null,
                  cur ? h('a', {
                    className: 'arxiv-meta', href: cur.url ?? `https://arxiv.org/abs/${cur.arxiv_id}`,
                    target: '_blank', rel: 'noopener',
                  }, 'arXiv ↗') : null),
                pane === undefined ? h('div', { className: 'arxiv-sub' }, '加载中… / loading')
                  : pane.err ? h('div', { className: 'arxiv-sub' }, `加载失败：${pane.err}`)
                    : MarkdownText
                      ? h('div', { className: 'arxiv-note-page' }, h(MarkdownText, { text: pane.md ?? '' }))
                      : h('pre', { className: 'arxiv-note-pre' }, mathToUnicode(pane.md ?? ''))))));
    }

    function AnalysisBlock({ arxivId, summary, analysisPath, onOpenNotes }) {
      const [open, setOpen] = useState(false);
      const [md, setMd] = useState(null);
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);
      const toggle = async () => {
        if (open) { setOpen(false); return; }
        setOpen(true);
        if (md !== null || busy) return;
        setBusy(true);
        try {
          const r = await fetch(`/arxiv-inspiration/api/papers/${encodeURIComponent(arxivId)}/analysis`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = await r.json();
          setMd(data.markdown ?? '');
        } catch (e) {
          setErr(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };
      return h('div', { className: 'arxiv-abs' },
        h('div', { className: 'arxiv-deepread' },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '📄 深读要点'),
          (summary ?? '').split('\n').filter(Boolean).map((line, i) =>
            h('div', { key: i, style: { paddingLeft: 8 } }, mathToUnicode(line))),
          h('button', { className: 'arxiv-fb', type: 'button', onClick: toggle },
            open ? '⌃ 收起完整笔记' : '📄 展开完整笔记（本页渲染）'),
          onOpenNotes ? h('button', {
            className: 'arxiv-fb', type: 'button', onClick: onOpenNotes,
            style: { marginLeft: 6 }, title: '在「深读笔记」页全宽阅读（KaTeX 公式 + paper-reader 讲解）',
          }, '⤢ 全宽阅读') : null,
          open ? h('div', { className: 'arxiv-note' },
            busy ? h('div', { className: 'arxiv-sub' }, '加载中… / loading')
              : err ? h('div', { className: 'arxiv-sub' }, `笔记加载失败：${err}`)
                : MarkdownText
                  ? h(MarkdownText, { text: md ?? '' })
                  : h('pre', { className: 'arxiv-note-pre' }, mathToUnicode(md ?? ''))
          ) : null));
    }

    /**
     * Push-collection tab: papers accumulated across surveys plus manual
     * picks, injected to one session in a single shot (清单 tab).
     */
    function CollectionTab({ collection, sessions, refreshCollection }) {
      const [sessionId, setSessionId] = useState('');
      const [note, setNote] = useState('');
      const [clearAfter, setClearAfter] = useState(false);
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState('');
      const [error, setError] = useState('');
      const [expanded, setExpanded] = useState(null);
      const [confirmClear, setConfirmClear] = useState(false);

      const items = collection?.items ?? [];
      const missingFulltext = items.filter((p) => !p.has_fulltext).length;
      const fetchFulltext = async () => {
        setError(''); setMsg('');
        try {
          const r = await api('/collection/fulltext', { method: 'POST' });
          setMsg(r.queued > 0
            ? `后台获取 ${r.queued} 篇全文中（逐篇下载 PDF），稍候刷新查看`
            : '全部论文已有全文存档');
        } catch (e) {
          setError(e.message);
        }
      };
      const push = async () => {
        if (!sessionId || busy) return;
        setBusy(true); setError(''); setMsg('');
        try {
          const r = await api('/collection/push', {
            method: 'POST',
            body: { sessionId, note, clear: clearAfter },
          });
          setMsg(`已注入 ${r.pushed} 篇（约 ${r.chars} 字符）${r.cleared ? '，清单已清空' : ''}`);
          refreshCollection();
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      };
      const remove = async (id) => {
        try {
          await api(`/collection/${encodeURIComponent(id)}`, { method: 'DELETE' });
          refreshCollection();
        } catch (e) {
          setError(e.message);
        }
      };
      const clearAll = async () => {
        if (!confirmClear) {
          setConfirmClear(true);
          setTimeout(() => setConfirmClear(false), 3000);
          return;
        }
        try {
          const r = await api('/collection', { method: 'DELETE' });
          setMsg(`已清空 ${r.cleared} 篇`);
          refreshCollection();
        } catch (e) {
          setError(e.message);
        } finally {
          setConfirmClear(false);
        }
      };
      const sourceLabel = (src) => (String(src).startsWith('survey')
        ? `调研 ${String(src.split(':')[1] ?? '').slice(0, 8)}`
        : src === 'agent' ? 'agent' : '手动');

      return h('div', { className: 'arxiv-card' },
        h('h3', { className: 'arxiv-title', style: { margin: 0 } }, '推送清单 / Push Collection'),
        h('div', { className: 'arxiv-meta' },
          `共 ${collection?.total ?? items.length} 篇（调研自动 ${collection?.auto_collected ?? 0} · 手动/agent ${collection?.manual ?? 0}）。` +
          '每次调研的推荐论文自动入列（可在调研配置关闭），也可在调研卡片或论文库手动加入；攒够一批后一次性注入给某个会话。'),
        h('div', { className: 'arxiv-row', style: { marginTop: 8 } },
          h('select', { className: 'arxiv-select', value: sessionId, onChange: (e) => setSessionId(e.target.value) },
            h('option', { value: '' }, '选择目标对话…'),
            sessions.map((s) =>
              h('option', { key: s.id, value: s.id }, `${String(s.title).slice(0, 40)} (${s.id.slice(0, 8)})`))),
          h('button', {
            className: 'arxiv-btn arxiv-btn-ghost', disabled: !sessionId || busy || items.length === 0, type: 'button',
            onClick: push,
            title: '把整份清单注入给该会话的 agent（英文论文列表 + 收集理由 + 摘要）',
          }, busy ? '注入中…' : `🤖 推送清单（${items.length} 篇）`),
          h('button', {
            className: 'arxiv-fb', 'data-on': String(clearAfter), type: 'button',
            onClick: () => setClearAfter(!clearAfter), role: 'switch', 'aria-checked': String(clearAfter),
            title: '推送成功后清空清单（不打移除标记：下次调研仍可重新收集）',
          }, clearAfter ? '推送后清空：开' : '推送后清空：关'),
          h('button', {
            className: 'arxiv-fb', type: 'button', onClick: fetchFulltext, disabled: items.length === 0 || missingFulltext === 0,
            title: '下载并存档缺全文论文的 PDF 文本（后台逐篇跑）；注入消息会引用全文路径',
          }, missingFulltext > 0 ? `📥 补全文（${missingFulltext}）` : '全文齐'),
          h('button', {
            className: 'arxiv-fb', type: 'button', onClick: clearAll, disabled: items.length === 0,
            title: '清空清单但不打移除标记（区别于单篇 ✕ 移除）',
          }, confirmClear ? '确认清空？' : '清空')),
        h('input', {
          className: 'arxiv-input', type: 'text', value: note,
          onChange: (e) => setNote(e.target.value),
          placeholder: '可选附言：注入时附带的说明（如“请精读前 5 篇的方法部分”）',
          style: { marginTop: 8 },
        }),
        items.length > 40
          ? h('div', { className: 'arxiv-meta', style: { marginTop: 6 } },
              `清单较长（${items.length} 篇）：注入消息约 ${Math.round(items.length * 1.2)}k 字符，确认目标会话需要完整列表再推送。`)
          : null,
        msg ? h('div', { className: 'arxiv-meta' }, msg) : null,
        error ? h('div', { className: 'arxiv-error' }, error) : null,
        h('div', { style: { marginTop: 10 } },
          items.length === 0
            ? h('span', { className: 'arxiv-sub' }, '清单为空。调研完成后推荐论文会自动入列；也可在调研卡片或论文库点「＋ 清单」。')
            : items.map((p, i) =>
                h('div', { key: p.arxiv_id, className: 'arxiv-paper' },
                  h('a', { href: p.url, target: '_blank', rel: 'noreferrer', className: 'arxiv-paper-title' },
                    `${i + 1}. ${p.title}`),
                  p.title_zh ? h('div', { className: 'arxiv-title-zh' }, mathToUnicode(p.title_zh)) : null,
                  h('div', { className: 'arxiv-row', style: { justifyContent: 'space-between' } },
                    h('span', { className: 'arxiv-meta' },
                      `${(p.categories ?? []).join(', ')} · ${p.arxiv_id} · ${sourceLabel(p.source)} · 收集于 ${String(p.added_at ?? '').slice(0, 10)}` +
                      (p.feedback ? ` · ${p.feedback === 'interested' ? '👍' : p.feedback === 'read' ? '📖' : '👎'}` : '') +
                      (p.has_analysis ? ' · 📄已深读' : '') +
                      (p.has_fulltext ? ' · 📑全文' : '') +
                      (p.in_library === false ? ' · ⚠️库外' : '')),
                    h('div', { className: 'arxiv-row' },
                      h('button', {
                        className: 'arxiv-fb', type: 'button',
                        onClick: () => setExpanded(expanded === p.arxiv_id ? null : p.arxiv_id),
                      }, expanded === p.arxiv_id ? '收起' : '摘要'),
                      h('button', {
                        className: 'arxiv-fb', type: 'button', onClick: () => remove(p.arxiv_id),
                        title: '移除并不再自动收集（手动重新加入可恢复）',
                      }, '✕'))),
                  p.note ? h('div', { className: 'arxiv-meta' }, `收集理由：${mathToUnicode(p.note)}`) : null,
                  expanded === p.arxiv_id && p.abstract
                    ? h('div', { className: 'arxiv-quote' }, mathToUnicode(p.abstract))
                    : null))));
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

    /** Full-page wrapper for the `main` seat (sidebar button entry). */
    function MainPage({ onClose }) {
      return h('div', { className: 'arxiv-mainwrap' },
        h('div', { className: 'arxiv-mainhead' },
          h('h2', { style: { margin: 0, fontSize: 16, fontWeight: 700 } }, '论文调研 · arXiv Inspiration'),
          onClose ? h('button', {
            className: 'arxiv-fb', type: 'button', onClick: onClose,
          }, '✕ 关闭') : null),
        h('div', { className: 'arxiv-mainscroll' }, h(Page)));
    }

    /** Sidebar panel-list icon: two stacked sheets with an arXiv dot. */
    function PanelIcon(props) {
      const size = (props && typeof props.size === 'number' && props.size) || 16;
      const active = !!(props && props.active);
      const color = active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)';
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size,
        'aria-hidden': 'true', style: { display: 'block' },
      },
        h('path', {
          d: 'M3.2 2.4h7.1a1 1 0 0 1 1 1v8.2h-1.2V3.6H3.2v8.2h1.2v1.2H3.2a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1z',
          fill: color,
        }),
        h('path', {
          d: 'M6.1 4.6h6.7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6.1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zm.2 1.2v6.6h6.3V5.8H6.3z',
          fill: color,
        }),
        h('circle', { cx: 9.45, cy: 9.1, r: 1.05, fill: color }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyleTag();
        // Open/close our main-area page. `layout` is not injected (this plugin
        // works on shells without it); selectPanel is best-effort.
        const selectPanel = (id) => {
          try { ctx.get('layout')?.selectPanel?.(id); } catch { /* optional seat */ }
        };
        // Primary entry: a sidebar panel-list button opening a full main page
        // (same pattern as the memory explorer). Falls back silently when the
        // seats are absent; the settings.section page below always works.
        try {
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              { name: 'main', key: MODULE_ID, inject: () => ({ onClose: () => selectPanel(null) }) },
              MainPage,
            ));
        } catch (e) { console.warn('[arxiv-inspiration] main seat unavailable', e); }
        try {
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: MODULE_ID, order: 8, label: '论文调研' },
              PanelIcon,
            ));
        } catch (e) { console.warn('[arxiv-inspiration] sidebar.panellist seat unavailable', e); }
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
