// ============================================================================
// Skill 全域自演化架构 — Client 半（UI）
// 纯 JS + React.createElement。由 cordis_define code.client 使用。
// 入口函数体：return { inject: ['timer'], async apply(ctx) { ... } }
// 模块：
//   A. conversation.input.dock  → 聊天输入区上方的通知卡片（最高频触点）
//   B/C/D/E. settings.section   → 「技能中心」仪表盘页（总览/待审核/配置/详情）
// ============================================================================
return {
  inject: ['timer'],
  async apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    const disposers = [];

    const css = `
      .sevo-dock { display:flex; flex-direction:column; gap:6px; width:100%; box-sizing:border-box; padding:6px 2px; }
      .sevo-empty { color:var(--dsh-text-muted, #888); font-size:12px; padding:2px 4px; }
      .sevo-card { border:1px solid var(--dsh-border, #333); border-left:3px solid #888; border-radius:8px;
        padding:8px 10px; background:var(--dsh-surface, rgba(255,255,255,0.04)); font-size:12px; }
      .sevo-card.sevo-promotion { border-left-color:#2ecc71; }
      .sevo-card.sevo-demotion { border-left-color:#e67e22; }
      .sevo-card.sevo-generation { border-left-color:#3498db; }
      .sevo-card.sevo-warning { border-left-color:#e74c3c; }
      .sevo-card.sevo-info, .sevo-card.sevo-success { border-left-color:#95a5a6; }
      .sevo-card-head { display:flex; justify-content:space-between; align-items:center; font-weight:600; }
      .sevo-card-time { color:var(--dsh-text-muted, #888); font-weight:400; font-size:11px; }
      .sevo-card-msg { margin:3px 0; color:var(--dsh-text-secondary, #bbb); }
      .sevo-card-metrics { display:flex; flex-wrap:wrap; gap:8px; margin:3px 0; }
      .sevo-metric { background:rgba(127,127,127,0.15); border-radius:4px; padding:1px 6px; font-size:11px; }
      .sevo-card-actions { display:flex; gap:6px; margin-top:5px; flex-wrap:wrap; }
      .sevo-btn { border:1px solid var(--dsh-border, #555); background:transparent; color:inherit;
        border-radius:6px; padding:3px 10px; font-size:12px; cursor:pointer; }
      .sevo-btn:hover { background:rgba(127,127,127,0.2); }
      .sevo-btn.sevo-primary { background:#2563eb; border-color:#2563eb; color:#fff; }
      .sevo-btn.sevo-ghost { opacity:0.6; }
      .sevo-page { padding:14px; font-size:13px; display:flex; flex-direction:column; gap:12px; }
      .sevo-row { display:flex; gap:8px; flex-wrap:wrap; }
      .sevo-stat { flex:1; min-width:110px; border:1px solid var(--dsh-border, #333); border-radius:8px; padding:8px 10px; }
      .sevo-stat b { font-size:20px; display:block; }
      .sevo-stat span { color:var(--dsh-text-muted, #888); font-size:11px; }
      .sevo-tabs { display:flex; gap:4px; }
      .sevo-tab { border:1px solid var(--dsh-border, #333); background:transparent; color:inherit;
        border-radius:6px 6px 0 0; padding:5px 14px; cursor:pointer; }
      .sevo-tab.active { background:rgba(37,99,235,0.25); border-color:#2563eb; }
      .sevo-panel { border:1px solid var(--dsh-border, #333); border-radius:0 8px 8px 8px; padding:10px; display:flex; flex-direction:column; gap:8px; }
      .sevo-list { display:flex; flex-direction:column; gap:4px; }
      .sevo-item { display:flex; justify-content:space-between; align-items:center; gap:8px;
        border:1px solid transparent; border-radius:6px; padding:4px 6px; }
      .sevo-item:hover { background:rgba(127,127,127,0.12); }
      .sevo-bar { height:8px; border-radius:4px; background:#2563eb; min-width:2px; }
      .sevo-barwrap { flex:1; display:flex; align-items:center; }
      .sevo-th { color:var(--dsh-text-muted, #888); font-size:11px; margin-top:2px; }
      .sevo-toggle { display:flex; align-items:center; justify-content:space-between; padding:6px 2px; }
      .sevo-toggle input { margin:0 6px 0 0; }
      .sevo-num { width:64px; background:rgba(127,127,127,0.15); border:1px solid var(--dsh-border,#444); color:inherit; border-radius:4px; padding:2px 6px; }
      .sevo-detail { border:1px dashed var(--dsh-border,#555); border-radius:8px; padding:8px; background:rgba(127,127,127,0.06); }
    `;
    styles.insert(css);

    // ---------------------------------------------------------------- 工具函数
    function timeAgo(t) {
      const s = Math.floor((Date.now() - t) / 1000);
      if (s < 60) return '刚刚';
      if (s < 3600) return Math.floor(s / 60) + '分钟前';
      if (s < 86400) return Math.floor(s / 3600) + '小时前';
      return Math.floor(s / 86400) + '天前';
    }

    // ---------------------------------------------------------------- 模块 A：通知卡片（输入区上方）
    function NotifyCards() {
      const [items, setItems] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const res = await host.call('evolve.notifications', { limit: 3, actionable: true });
            if (alive) setItems((res && res.items) || []);
          } catch (e) {
            if (alive) setItems([]);
          }
        };
        tick();
        const disposer = ctx.interval(tick, 5000);
        return () => { alive = false; if (disposer) disposer(); };
      }, []);
      const act = async (id, actionId) => {
        setBusy(true);
        try { await host.call('evolve.action', { notificationId: id, actionId }); } catch (e) {}
        try {
          const res = await host.call('evolve.notifications', { limit: 3, actionable: true });
          setItems((res && res.items) || []);
        } catch (e) {}
        setBusy(false);
      };
      if (items === null) return React.createElement('div', { className: 'sevo-dock sevo-empty' }, '技能演化系统加载中…');
      if (items.length === 0) return React.createElement('div', { className: 'sevo-dock sevo-empty' }, '🔔 技能演化：无待处理通知');
      return React.createElement('div', { className: 'sevo-dock' },
        items.map(n => React.createElement('div', { key: n.id, className: 'sevo-card sevo-' + n.type },
          React.createElement('div', { className: 'sevo-card-head' },
            React.createElement('span', null, n.icon + ' ' + n.title),
            React.createElement('span', { className: 'sevo-card-time' }, timeAgo(n.createdAt))),
          React.createElement('div', { className: 'sevo-card-msg' }, n.message),
          (n.metrics && n.metrics.length) ? React.createElement('div', { className: 'sevo-card-metrics' },
            n.metrics.map(m => React.createElement('span', { key: m.label, className: 'sevo-metric' }, m.label + ': ' + m.value + (m.threshold ? '（' + m.threshold + '）' : '')))) : null,
          React.createElement('div', { className: 'sevo-card-actions' },
            (n.actions || []).map(a => React.createElement('button', { key: a.id, className: 'sevo-btn' + (a.primary ? ' sevo-primary' : ''), disabled: busy, onClick: () => act(n.id, a.id) }, a.label)),
            React.createElement('button', { className: 'sevo-btn sevo-ghost', disabled: busy, onClick: () => act(n.id, 'dismiss') }, '✕'))
        )));
    }
    slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'skill-evolve-cards', order: 15 },
      () => React.createElement(NotifyCards)
    ));

    // ---------------------------------------------------------------- 模块 B/C/D/E：技能中心（设置页）
    function SkillCenter() {
      const [state, setState] = React.useState(null);
      const [tab, setTab] = React.useState('overview');
      const [detail, setDetail] = React.useState(null);
      const [cfgDraft, setCfgDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const load = async () => {
        try {
          const res = await host.call('evolve.state');
          setState(res);
          if (!cfgDraft && res && res.config) setCfgDraft(JSON.parse(JSON.stringify(res.config)));
        } catch (e) {}
      };
      React.useEffect(() => {
        load();
        const disposer = ctx.interval(load, 10000);
        return () => { if (disposer) disposer(); };
      }, []);
      const run = async (method, args) => {
        setBusy(true);
        try { await host.call(method, args); await load(); } catch (e) {}
        setBusy(false);
      };
      const openDetail = async (name) => {
        try { setDetail(await host.call('evolve.detail', { name })); } catch (e) {}
      };
      const saveCfg = async () => {
        setBusy(true);
        try { await host.call('evolve.config.update', { patch: cfgDraft }); await load(); } catch (e) {}
        setBusy(false);
      };

      if (!state) return React.createElement('div', { className: 'sevo-page' }, '技能中心加载中…');
      const cfg = state.config;
      const c = state.counts;

      const statCard = (label, value) => React.createElement('div', { className: 'sevo-stat', key: label },
        React.createElement('b', null, String(value)), React.createElement('span', null, label));

      const panel = (title, children) => React.createElement('div', { className: 'sevo-panel' },
        React.createElement('div', { style: { fontWeight: 600 } }, title), children);

      // --- 总览
      const heatmapPanel = panel('📊 热度排行（30天调用占比）', React.createElement('div', { className: 'sevo-list' },
          (state.heatmap || []).length === 0 ? React.createElement('div', { className: 'sevo-th' }, '暂无调用数据') :
            state.heatmap.map(h => React.createElement('div', { className: 'sevo-item', key: h.name },
              React.createElement('span', { style: { minWidth: 130 }, onClick: () => openDetail(h.name), title: '查看详情' }, h.name),
              React.createElement('div', { className: 'sevo-barwrap' },
                React.createElement('div', { className: 'sevo-bar', style: { width: Math.max(2, Math.min(100, h.frequencyRate * 6000)) + '%' } })),
              React.createElement('span', { className: 'sevo-th' }, (h.frequencyRate * 100).toFixed(3) + '%')))));
      const endangeredPanel = panel('⚠️ 濒临降级预警', React.createElement('div', { className: 'sevo-list' },
          (state.endangered || []).length === 0 ? React.createElement('div', { className: 'sevo-th' }, '暂无濒临降级技能') :
            state.endangered.map(e => React.createElement('div', { className: 'sevo-item', key: e.name },
              React.createElement('span', { style: { minWidth: 130 }, onClick: () => openDetail(e.name) }, e.name),
              React.createElement('span', { className: 'sevo-th' }, (e.frequencyRate * 100).toFixed(4) + '% · ' + e.status)))));
      const overviewView = React.createElement('div', { className: 'sevo-row' }, heatmapPanel, endangeredPanel);

      const timelineView = panel('📋 演化时间线（最近变更）', React.createElement('div', { className: 'sevo-list' },
        (state.timeline || []).length === 0 ? React.createElement('div', { className: 'sevo-th' }, '暂无变更记录') :
          state.timeline.slice(0, 8).map(t => React.createElement('div', { className: 'sevo-item', key: t.id },
            React.createElement('span', null, (t.action === 'promote' ? '🔼' : t.action === 'demote' ? '🔽' : t.action === 'split' ? '✂️' : '🧬') + ' ' + t.skillId + ' → ' + t.action),
            React.createElement('span', { className: 'sevo-th' }, timeAgo(t.createdAt))))));

      const notifyView = panel('🔔 最近通知', React.createElement('div', { className: 'sevo-list' },
        (state.notifications || []).slice(0, 5).map(n => React.createElement('div', { className: 'sevo-item', key: n.id },
          React.createElement('span', null, n.icon + ' ' + n.title),
          React.createElement('span', { className: 'sevo-th' }, timeAgo(n.createdAt))))));

      // --- 待审核
      const reviewView = panel('📋 待审核 Skill 提案', React.createElement('div', { className: 'sevo-list' },
        (state.reviews || []).length === 0 ? React.createElement('div', { className: 'sevo-th' }, '暂无待审核提案') :
          state.reviews.map(r => React.createElement('div', { className: 'sevo-item', key: r.id },
            React.createElement('span', { style: { flex: 1 } }, '🧠 ' + r.skillName),
            React.createElement('span', { className: 'sevo-th' }, '生成于 ' + timeAgo(r.createdAt)),
            React.createElement('button', { className: 'sevo-btn sevo-primary', disabled: busy, onClick: () => run('evolve.review', { reviewId: r.id, action: 'accept' }) }, '✅ 通过'),
            React.createElement('button', { className: 'sevo-btn', disabled: busy, onClick: () => run('evolve.review', { reviewId: r.id, action: 'reject' }) }, '❌ 拒绝')))));

      // --- 配置
      const toggle = (key, label) => React.createElement('label', { className: 'sevo-toggle', key: key },
        React.createElement('span', null, label),
        React.createElement('input', { type: 'checkbox', checked: !!cfgDraft[key], onChange: (e) => setCfgDraft(Object.assign({}, cfgDraft, { [key]: e.target.checked })) }));
      const numField = (key, label, min, max) => React.createElement('label', { className: 'sevo-toggle', key: key },
        React.createElement('span', null, label),
        React.createElement('input', { className: 'sevo-num', type: 'number', min: min, max: max, value: cfgDraft[key], onChange: (e) => setCfgDraft(Object.assign({}, cfgDraft, { [key]: Number(e.target.value) })) }));
      const cfgView = panel('⚙️ 技能演化设置',
        toggle('allow_auto_promote', '🚀 允许专用 Skill 自动升级为全局'),
        toggle('allow_auto_demote', '📉 允许全局 Skill 自动降级为专用'),
        toggle('allow_auto_generate_skill', '🧠 允许检测到能力缺口时自动生成 Skill'),
        toggle('observer_mode_only', '🔬 观察者模式（仅观察不应用，安全模式）'),
        toggle('notify_on_auto_action', '🔔 自动变更时发送通知'),
        toggle('notify_on_warning', '⚠️ 告警通知'),
        numField('auto_generate_threshold', '生成触发阈值（连续缺失次数）', 1, 10),
        numField('blocklist_threshold', '黑名单阈值（拒绝次数）', 1, 10),
        React.createElement('div', { className: 'sevo-row' },
          React.createElement('button', { className: 'sevo-btn sevo-primary', disabled: busy, onClick: saveCfg }, '💾 保存设置'),
          React.createElement('button', { className: 'sevo-btn', disabled: busy, onClick: () => run('evolve.selftest', {}) }, '🧪 运行自验证套件')));

      // --- 详情抽屉（内联）
      const detailView = detail ? React.createElement('div', { className: 'sevo-detail' },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between' } },
          React.createElement('b', null, '📄 ' + (detail.skill ? detail.skill.name : detail.scope)),
          React.createElement('button', { className: 'sevo-btn sevo-ghost', onClick: () => setDetail(null) }, '✕')),
        detail.skill ? React.createElement('div', null,
          React.createElement('div', { className: 'sevo-th' }, '描述：' + detail.skill.description),
          React.createElement('div', { className: 'sevo-th' }, '作用域：' + detail.scope + ' · 版本 ' + detail.skill.meta.version +
            ' · 锁定：' + (detail.skill.meta.user_locked ? '🔒是' : '否') + ' · 自动生成：' + (detail.skill.meta.auto_generated ? '是' : '否')),
          React.createElement('div', { className: 'sevo-th' }, '30天调用：' + detail.stats.totalCalls + ' · 成功率：' + ((detail.stats.successRate || 0) * 100).toFixed(1) + '% · 占比：' + ((detail.stats.frequencyRate || 0) * 100).toFixed(4) + '%'),
          React.createElement('div', { className: 'sevo-th' }, '趋势（30天）：' + detail.stats.trend30d.map(n => n > 0 ? '█' : '·').join('')))
        : React.createElement('div', { className: 'sevo-th' }, '未找到该技能'),
        React.createElement('div', { className: 'sevo-th' }, '变更历史：'),
        (detail.history || []).map(h => React.createElement('div', { className: 'sevo-item', key: h.createdAt },
          React.createElement('span', null, (h.action === 'promote' ? '🔼' : h.action === 'demote' ? '🔽' : h.action === 'split' ? '✂️' : '🧬') + ' ' + h.action + (h.operator ? ' · ' + h.operator : '')),
          React.createElement('span', { className: 'sevo-th' }, timeAgo(h.createdAt))))) : null;

      const body = tab === 'overview'
        ? React.createElement('div', null, overviewView, timelineView, notifyView)
        : tab === 'reviews'
          ? reviewView
          : React.createElement('div', null, cfgView);

      return React.createElement('div', { className: 'sevo-page' },
        React.createElement('div', { className: 'sevo-row' },
          statCard('全局 Skills', c.global), statCard('专用 Skills', c.workspace),
          statCard('候选池', c.pool), statCard('待审核', c.pendingReviews), statCard('未读通知', c.unread)),
        React.createElement('div', { className: 'sevo-tabs' },
          React.createElement('button', { className: 'sevo-tab' + (tab === 'overview' ? ' active' : ''), onClick: () => setTab('overview') }, '📊 总览'),
          React.createElement('button', { className: 'sevo-tab' + (tab === 'reviews' ? ' active' : ''), onClick: () => setTab('reviews') }, '📋 待审核' + (c.pendingReviews ? ' (' + c.pendingReviews + ')' : '')),
          React.createElement('button', { className: 'sevo-tab' + (tab === 'config' ? ' active' : ''), onClick: () => setTab('config') }, '⚙️ 配置')),
        React.createElement('div', { className: 'sevo-panel', style: { borderRadius: '0 8px 8px 8px' } }, body),
        detailView,
        React.createElement('div', { className: 'sevo-th' }, '系统根目录：' + state.root + ' · 刷新于 ' + timeAgo(state.updatedAt ? Date.parse(state.updatedAt) : 0)));
    }
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'skill-evolve', order: 5, label: '技能中心' },
      () => React.createElement(SkillCenter)
    ));

    return () => { for (const d of disposers) d(); };
  }
};
