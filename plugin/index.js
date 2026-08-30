// ============================================================================
// Skill 全域自演化架构 — 常驻宿主插件（所有 session 生效，重启后自动加载）
// ----------------------------------------------------------------------------
// 通过 D:\DSH\profiles\web\cordis.patch.yml 挂载到宿主组合（web profile）。
// DSH 启动即加载本插件：引擎常驻、5 个 evolve_* 工具对全部 session 的 agent
// 可见、演化数据持久化于 D:/DSH/.skill-evolve 随使用持续演化。
// 另注册网页仪表盘：http://127.0.0.1:3080/skill-evolve
//
// 静态插件格式：ESM 命名导出 { name, inject, apply }，可 import node 模块。
// 与动态插件差异：无 harness（工具用 ctx.tools.register + defineTool）。
// ============================================================================
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'skill-evolve-host'
export const inject = ['fs', 'timer', 'tools']

export async function apply(ctx) {
  const ROOT = 'D:/DSH/.skill-evolve'
  const DAY = 86400000

  // ---------------------------------------------------------------- 引擎工厂（与动态版同源）
  // 注：apply 为 async（内部 await engine.ensureInit()）
  function createEngine(root) {
    const fs = ctx.fs
    const G = root + '/global-skills'
    const P = root + '/promotion-pool'
    const M = root + '/metrics'
    const CFG_PATH = root + '/config.json'
    const CALS = M + '/skill_calls.json'
    const DAILY = M + '/daily_aggregates.json'
    const LEDGER = M + '/promotion_ledger.json'
    const NOTIF = M + '/notifications.json'
    const REJECT = M + '/rejected_feedback.json'
    const POOL_AUDIT = M + '/promotion_pool_audit.json'
    const MISSES = M + '/misses.json'
    const MUTES = M + '/mutes.json'
    const REVIEWS = M + '/reviews.json'

    let nowOverride = null
    const now = () => (nowOverride !== null ? nowOverride : Date.now())
    const nowIso = () => new Date(now()).toISOString()
    function setNow(ms) { nowOverride = ms }

    async function rdText(p) {
      try {
        const t = await fs.resolve(p)
        const i = await fs.stat(t)
        if (!i) return null
        return await fs.readText(t)
      } catch (e) { return null }
    }
    async function wrText(p, c) {
      const t = await fs.resolve(p)
      await fs.writeText(t, c, undefined, undefined, { mode: 'danger-full-access' })
    }
    async function rdJson(p, fb) {
      const s = await rdText(p)
      if (s === null || s === '') return fb
      try { return JSON.parse(s) } catch (e) { return fb }
    }
    async function wrJson(p, o) { await wrText(p, JSON.stringify(o, null, 2)) }
    async function fileExists(p) { try { const t = await fs.resolve(p); const i = await fs.stat(t); return !!i } catch (e) { return false } }
    async function listDir(p) {
      try {
        const t = await fs.resolve(p)
        const i = await fs.stat(t)
        if (!i || i.type !== 'directory') return []
        return await fs.listDir(t)
      } catch (e) { return [] }
    }
    async function listDirNames(p) {
      const entries = await listDir(p)
      const out = []
      for (const en of entries) if (en.type === 'directory') out.push(en.name)
      return out
    }
    async function removeDir(p) {
      const sub = ctx.get('subprocess')
      if (sub) {
        try {
          const exe = await sub.resolveExecutable('node')
          const script = "require('fs').rmSync(" + JSON.stringify(p) + ",{recursive:true,force:true})"
          const parent = p.replace(/[\\/]+[^\\/]*$/, '') || '/'
          const handle = sub.spawn({
            argv: [exe, '-e', script],
            cwd: parent,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
            graceMs: 15000
          })
          const outcome = await handle.done
          if (outcome && outcome.exitCode === 0) return true
        } catch (e) { /* fall through */ }
      }
      await wrText(p + '/.removed', 'removed at ' + now())
      return false
    }
    async function isRemovedDir(dir) {
      const t = await rdText(dir + '/.removed')
      return t !== null && t !== ''
    }
    async function clearRemovedMarker(dir) {
      await wrText(dir + '/.removed', '')
    }
    function hashStr(s) {
      let h = 0x811c9dc5
      const bytes = new TextEncoder().encode(String(s))
      for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = (h * 0x01000193) >>> 0 }
      return h.toString(16).padStart(8, '0')
    }
    function dateKey(t) {
      const d = new Date(t)
      return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
    }
    function tokenize(s) { return String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean) }
    function jaccard(a, b) {
      const A = new Set(tokenize(a)), B = new Set(tokenize(b))
      if (A.size === 0 || B.size === 0) return 0
      let inter = 0
      for (const t of A) if (B.has(t)) inter++
      return inter / (A.size + B.size - inter)
    }
    function bumpVersion(v) {
      const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '1.0.0'))
      if (!m) return '1.0.1'
      return m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1)
    }
    function slugify(s) {
      return String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '')
    }

    const DEFAULT_CONFIG = {
      version: 1,
      allow_auto_promote: true,
      allow_auto_demote: true,
      allow_auto_generate_skill: true,
      observer_mode_only: false,
      auto_generate_threshold: 3,
      blocklist_threshold: 3,
      promotion_threshold: 0.001,
      demotion_threshold: 0.0001,
      promotion_success_rate: 0.92,
      cooldown_days: 30,
      window_days: 30,
      bootstrap_skills: [
        { name: 'read-file', description: '读取当前工作区文件内容' },
        { name: 'search-code', description: '在代码库中搜索关键词' },
        { name: 'run-shell', description: '执行 Shell 命令' }
      ],
      notify_on_auto_action: true,
      notify_on_warning: true
    }
    async function loadConfig() {
      const c = await rdJson(CFG_PATH, null)
      return Object.assign({}, DEFAULT_CONFIG, c || {})
    }
    async function saveConfig(patch) {
      const c = await loadConfig()
      const next = Object.assign({}, c, patch || {})
      await wrJson(CFG_PATH, next)
      return next
    }

    const META_KEYS = ['name', 'scope', 'origin_ws', 'aliases', 'version', 'auto_generated', 'forbid_promotion', 'forbid_demotion', 'user_locked', 'is_bootstrap', 'success_rate', 'frequency_rate', 'last_called_at', 'total_calls', 'promotion_state', 'promotion_history', 'coupling_tags', 'updated_at']
    function parseMetaValue(v) {
      if (v === 'true') return true
      if (v === 'false') return false
      if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
      if (v.startsWith('[') && v.endsWith(']')) {
        const inner = v.slice(1, -1).trim()
        if (!inner) return []
        return inner.split(',').map(s => s.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
      }
      return v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    }
    function parseFrontmatter(text) {
      const meta = {}
      let body = text
      if (String(text).startsWith('---')) {
        const end = String(text).indexOf('\n---', 3)
        if (end !== -1) {
          const fm = String(text).slice(3, end).trim()
          for (const line of fm.split('\n')) {
            const idx = line.indexOf(':')
            if (idx === -1) continue
            meta[line.slice(0, idx).trim()] = parseMetaValue(line.slice(idx + 1).trim())
          }
          body = String(text).slice(end + 4).replace(/^\n+/, '')
        }
      }
      return { meta, body }
    }
    function serializeSkill(meta, body) {
      const lines = ['---']
      for (const k of META_KEYS) {
        const v = meta[k]
        if (Array.isArray(v)) lines.push(k + ': [' + v.map(x => '"' + String(x).replace(/"/g, '\\"') + '"').join(', ') + ']')
        else if (typeof v === 'string') lines.push(k + ': ' + v)
        else lines.push(k + ': ' + String(v))
      }
      lines.push('---')
      lines.push('')
      lines.push(body || '')
      return lines.join('\n')
    }
    function extractDescription(body) {
      const m = /#\s*description\s*\n([^\n#]*)/.exec(body || '')
      return m ? m[1].trim() : ''
    }
    function normalizeMeta(meta) {
      const base = {
        name: '', scope: 'workspace-only', origin_ws: '', aliases: [], version: '1.0.0',
        auto_generated: false, forbid_promotion: false, forbid_demotion: false, user_locked: false,
        is_bootstrap: false, success_rate: 0, frequency_rate: 0, last_called_at: 0, total_calls: 0,
        promotion_state: 'none', promotion_history: [], coupling_tags: [], updated_at: 0
      }
      return Object.assign(base, meta || {})
    }
    function skillView(name, meta, body) {
      return { name, meta, body, description: extractDescription(body) }
    }

    const wsSkillsDir = (wsPath) => wsPath + '/.dsh/workspace-skills'
    async function readSkillFile(p) {
      const raw = await rdText(p)
      if (raw === null || raw === '') return null
      const { meta, body } = parseFrontmatter(raw)
      return { meta: normalizeMeta(meta), body, raw }
    }
    async function readGlobalSkill(name) {
      if (await isRemovedDir(G + '/' + name)) return null
      return readSkillFile(G + '/' + name + '/SKILL.md')
    }
    async function readWsSkill(wsPath, name) {
      if (await isRemovedDir(wsSkillsDir(wsPath) + '/' + name)) return null
      return readSkillFile(wsSkillsDir(wsPath) + '/' + name + '/SKILL.md')
    }
    async function writeGlobalSkill(name, meta, body) {
      const dir = G + '/' + name
      await wrText(dir + '/SKILL.md', serializeSkill(meta, body))
      await clearRemovedMarker(dir)
    }
    async function writeWsSkill(wsPath, name, meta, body) {
      const dir = wsSkillsDir(wsPath) + '/' + name
      await wrText(dir + '/SKILL.md', serializeSkill(meta, body))
      await clearRemovedMarker(dir)
    }
    async function listGlobalSkills() {
      const names = await listDirNames(G)
      const out = []
      for (const n of names) {
        const s = await readGlobalSkill(n)
        if (s) out.push(skillView(n, s.meta, s.body))
      }
      return out
    }
    async function listWsSkills(wsPath) {
      const dir = wsSkillsDir(wsPath)
      const names = await listDirNames(dir)
      const out = []
      for (const n of names) {
        const s = await readWsSkill(wsPath, n)
        if (s) out.push(skillView(n, s.meta, s.body))
      }
      return out
    }
    async function findSkillByName(name) {
      const g = await readGlobalSkill(name)
      if (g) return { scope: 'global', skill: g }
      const mountedWs = [...mounted.keys()]
      for (const ws of mountedWs) {
        const s = await readWsSkill(ws, name)
        if (s) return { scope: 'workspace', wsPath: ws, skill: s }
      }
      return null
    }
    async function listActiveSkills(wsPath) {
      const globals = await listGlobalSkills()
      const ws = wsPath ? await listWsSkills(wsPath) : []
      return [
        ...globals.map(s => ({ name: s.name, scope: 'global', description: s.description, meta: s.meta })),
        ...ws.map(s => ({ name: s.name, scope: 'workspace', description: s.description, meta: s.meta }))
      ]
    }

    const mounted = new Map()
    function mountWorkspace(wsPath, wsId) {
      mounted.set(wsPath, { wsId: wsId || wsPath, mountedAt: now() })
      return mounted.get(wsPath)
    }
    function unmountWorkspace(wsPath) { mounted.delete(wsPath) }
    function isMounted(wsPath) { return mounted.has(wsPath) }

    function scoreMatch(query, skill) {
      const q = tokenize(query)
      if (q.length === 0) return 0
      const nameTok = tokenize(String(skill.name).replace(/-/g, ' '))
      const descTok = tokenize(skill.description)
      const tagTok = tokenize((skill.meta.coupling_tags || []).join(' '))
      const corpus = new Set([...nameTok, ...descTok, ...tagTok])
      let matched = 0
      for (const t of q) if (corpus.has(t)) matched++
      const denom = Math.max(q.length, nameTok.length)
      return matched / denom
    }

    async function resolveSkill(query, wsPath) {
      const cfg = await loadConfig()
      const q = String(query || '').trim()
      const ql = q.toLowerCase()
      for (const b of cfg.bootstrap_skills || []) {
        if (b.name.toLowerCase() === ql || scoreMatch(q, { name: b.name, description: b.description, meta: {} }) >= 0.5) {
          const meta = normalizeMeta({ name: b.name, scope: 'bootstrap', is_bootstrap: true })
          return { skill: skillView(b.name, meta, '# description\n' + b.description + '\n\n# instructions\n（内置引导技能）'), scope: 'bootstrap' }
        }
      }
      const globals = await listGlobalSkills()
      for (const s of globals) {
        if (s.name.toLowerCase() === ql) return { skill: s, scope: 'global' }
      }
      if (wsPath) {
        const wsExact = await listWsSkills(wsPath)
        for (const s of wsExact) {
          if (s.name.toLowerCase() === ql) return { skill: s, scope: 'workspace' }
        }
      }
      let best = null, bestScore = 0
      for (const s of globals) {
        const sc = scoreMatch(q, s)
        if (sc > bestScore) { bestScore = sc; best = s }
      }
      if (best && bestScore >= 0.5) return { skill: best, scope: 'global' }
      if (wsPath) {
        const ws = await listWsSkills(wsPath)
        best = null; bestScore = 0
        for (const s of ws) {
          const sc = scoreMatch(q, s)
          if (sc > bestScore) { bestScore = sc; best = s }
        }
        if (best && bestScore >= 0.5) return { skill: best, scope: 'workspace' }
      }
      return null
    }

    async function recordCall(p) {
      const calls = await rdJson(CALS, [])
      const t = p.time !== undefined ? p.time : now()
      const rec = {
        id: hashStr(p.skillId + ':' + t + ':' + Math.random()),
        skillId: p.skillId, scope: p.scope || 'workspace', wsId: p.wsId || null,
        sessionId: p.sessionId || null, callTime: t, success: !!p.success,
        input: p.input || null, inputHash: p.input ? hashStr(p.input) : null,
        inputTags: p.inputTags || [], costTokens: p.costTokens || 0
      }
      calls.push(rec)
      const cutoff = now() - 60 * DAY
      await wrJson(CALS, calls.filter(c => c.callTime >= cutoff))
      const daily = await rdJson(DAILY, {})
      const date = dateKey(t)
      if (!daily[date]) daily[date] = {}
      const d = daily[date][p.skillId] || { total: 0, success: 0 }
      d.total++; if (p.success) d.success++
      daily[date][p.skillId] = d
      await wrJson(DAILY, daily)
      const found = await findSkillByName(p.skillId)
      if (found && found.scope !== 'bootstrap') {
        const s = found.skill
        s.meta.last_called_at = t
        s.meta.total_calls = (s.meta.total_calls || 0) + 1
        const total = s.meta.total_calls
        s.meta.success_rate = total <= 1 ? (p.success ? 1 : 0) : (s.meta.success_rate * (total - 1) + (p.success ? 1 : 0)) / total
        s.meta.updated_at = now()
        if (found.scope === 'global') await writeGlobalSkill(s.name, s.meta, s.body)
        else await writeWsSkill(found.wsPath, s.name, s.meta, s.body)
      }
      return rec
    }
    async function recordCallsBulk(payloads) {
      if (!payloads || payloads.length === 0) return { count: 0 }
      const calls = await rdJson(CALS, [])
      const daily = await rdJson(DAILY, {})
      const t0 = now()
      for (const p of payloads) {
        const t = p.time !== undefined ? p.time : t0
        calls.push({
          id: hashStr(p.skillId + ':' + t + ':' + Math.random()),
          skillId: p.skillId, scope: p.scope || 'workspace', wsId: p.wsId || null,
          sessionId: p.sessionId || null, callTime: t, success: !!p.success,
          input: p.input || null, inputHash: p.input ? hashStr(p.input) : null,
          inputTags: p.inputTags || [], costTokens: p.costTokens || 0
        })
        const date = dateKey(t)
        if (!daily[date]) daily[date] = {}
        const d = daily[date][p.skillId] || { total: 0, success: 0 }
        d.total++; if (p.success) d.success++
        daily[date][p.skillId] = d
      }
      const cutoff = now() - 60 * DAY
      await wrJson(CALS, calls.filter(c => c.callTime >= cutoff))
      await wrJson(DAILY, daily)
      return { count: payloads.length }
    }
    async function getSkillStats(name) {
      const calls = await rdJson(CALS, [])
      const nowMs = now()
      const w1 = nowMs - 30 * DAY
      const w2 = w1 - 30 * DAY
      const recent = calls.filter(c => c.skillId === name && c.callTime >= w1)
      const older = calls.filter(c => c.skillId === name && c.callTime >= w2 && c.callTime < w1)
      const totalAll = calls.filter(c => c.callTime >= w1).length
      const totalAllOld = calls.filter(c => c.callTime >= w2 && c.callTime < w1).length
      if (recent.length === 0) {
        return { name, frequencyRate: 0, successRate: 0, trend30d: [], totalCalls: 0, isPromotionCandidate: false, isDemotionCandidate: false, recentFreq: 0, oldFreq: 0 }
      }
      const success = recent.filter(c => c.success).length
      let rawFreq = totalAll > 0 ? recent.length / totalAll : 0
      const found = await findSkillByName(name)
      const autoWeight = found && found.skill.meta.auto_generated ? 0.5 : 1
      rawFreq = rawFreq * autoWeight
      const successRate = success / recent.length
      const oldFreq = totalAllOld > 0 ? older.length / totalAllOld : 0
      const trend30d = []
      for (let i = 29; i >= 0; i--) {
        const ds = nowMs - i * DAY, de = ds + DAY
        trend30d.push(calls.filter(c => c.skillId === name && c.callTime >= ds && c.callTime < de).length)
      }
      return {
        name, frequencyRate: rawFreq, successRate, trend30d, totalCalls: recent.length,
        isPromotionCandidate: rawFreq >= 0.001 && successRate >= 0.92,
        isDemotionCandidate: oldFreq <= 0.0001 && rawFreq <= 0.0001,
        recentFreq: rawFreq, oldFreq
      }
    }
    async function getHeatmap(topN, rangeDays) {
      const calls = await rdJson(CALS, [])
      const since = now() - (rangeDays || 30) * DAY
      const agg = {}
      for (const c of calls) {
        if (c.callTime < since) continue
        agg[c.skillId] = agg[c.skillId] || { total: 0, success: 0 }
        agg[c.skillId].total++; if (c.success) agg[c.skillId].success++
      }
      // 合并注册表中全部技能（含 0 调用），保证热度排名完整
      const names = new Set(Object.keys(agg))
      for (const g of await listGlobalSkills()) names.add(g.name)
      const wsRoot = root + '/workspaces'
      for (const ws of await listDirNames(wsRoot)) {
        for (const s of await listWsSkills(wsRoot + '/' + ws)) names.add(s.name)
      }
      const total = calls.filter(c => c.callTime >= since).length || 1
      const rows = [...names].map(k => {
        const a = agg[k] || { total: 0, success: 0 }
        return {
          name: k,
          calls: a.total,
          successRate: a.total > 0 ? a.success / a.total : 0,
          frequencyRate: a.total / total
        }
      }).sort((a, b) => b.frequencyRate - a.frequencyRate)
      return rows.slice(0, topN || 10)
    }
    async function getEndangeredSkills() {
      const globals = await listGlobalSkills()
      const out = []
      for (const g of globals) {
        const st = await getSkillStats(g.name)
        if (st.totalCalls === 0 || (st.recentFreq <= 0.0001 * 1.5 && st.oldFreq <= 0.0001 * 1.5)) {
          out.push({ name: g.name, frequencyRate: st.recentFreq, oldFrequencyRate: st.oldFreq, calls: st.totalCalls, status: st.isDemotionCandidate ? 'demotion-candidate' : 'watch' })
        }
      }
      return out
    }
    async function runDailyAggregation() {
      const calls = await rdJson(CALS, [])
      const daily = {}
      for (const c of calls) {
        const d = dateKey(c.callTime)
        if (!daily[d]) daily[d] = {}
        const row = daily[d][c.skillId] || { total: 0, success: 0 }
        row.total++; if (c.success) row.success++
        daily[d][c.skillId] = row
      }
      await wrJson(DAILY, daily)
      return { dates: Object.keys(daily).length }
    }
    function levenshtein(a, b) {
      const m = a.length, n = b.length
      if (m === 0) return n
      if (n === 0) return m
      let prev = new Array(n + 1), cur = new Array(n + 1)
      for (let j = 0; j <= n; j++) prev[j] = j
      for (let i = 1; i <= m; i++) {
        cur[0] = i
        for (let j = 1; j <= n; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        }
        [prev, cur] = [cur, prev]
      }
      return prev[n]
    }
    async function runPromotionPoolGC() {
      const audit = await rdJson(POOL_AUDIT, [])
      const entries = await listDir(P)
      let cleaned = 0
      for (const en of entries) {
        if (en.type !== 'directory') continue
        const row = audit.find(a => a.candidate_id === en.name)
        if (!row) continue
        if (row.status === 'active' && now() - row.created_at > 7 * DAY) {
          await removeDir(P + '/' + en.name)
          row.status = 'expired'; row.expired_at = now()
          cleaned++
        }
      }
      const actives = audit.filter(a => a.status === 'active')
      for (let i = 0; i < actives.length; i++) {
        for (let j = i + 1; j < actives.length; j++) {
          const A = actives[i], B = actives[j]
          if (A.origin_skill_id !== B.origin_skill_id) continue
          const aTxt = await rdText(P + '/' + A.candidate_id + '/SKILL.md.generic')
          const bTxt = await rdText(P + '/' + B.candidate_id + '/SKILL.md.generic')
          if (aTxt === null || bTxt === null) continue
          const longer = Math.max(aTxt.length, bTxt.length)
          const sim = 1 - levenshtein(aTxt, bTxt) / (longer || 1)
          if (sim > 0.9) {
            const keep = A.created_at >= B.created_at ? A : B
            const drop = keep === A ? B : A
            await removeDir(P + '/' + drop.candidate_id)
            drop.status = 'garbage_collected'
            cleaned++
          }
        }
      }
      await wrJson(POOL_AUDIT, audit)
      return cleaned
    }

    async function appendLedger(entry) {
      const ledger = await rdJson(LEDGER, [])
      ledger.push(Object.assign({ id: 'l-' + hashStr(entry.skillId + ':' + entry.action + ':' + now() + ':' + Math.random()).slice(0, 10), created_at: now() }, entry))
      await wrJson(LEDGER, ledger)
      return ledger[ledger.length - 1]
    }
    async function getLedgerSnapshotBefore(name, action) {
      const ledger = await rdJson(LEDGER, [])
      const row = ledger.filter(l => l.skillId === name && l.action === action).sort((a, b) => b.created_at - a.created_at)[0]
      return row ? row.snapshot_before : null
    }
    async function cooldownUntil(skillId) {
      const ledger = await rdJson(LEDGER, [])
      const last = ledger.filter(l => l.skillId === skillId && (l.action === 'promote' || l.action === 'demote')).sort((a, b) => b.created_at - a.created_at)[0]
      if (!last) return null
      const until = last.created_at + 30 * DAY
      return now() < until ? until : null
    }

    async function poolAuditAppend(candidateId, originSkillId, status, createdAt) {
      const audit = await rdJson(POOL_AUDIT, [])
      audit.push({ candidate_id: candidateId, origin_skill_id: originSkillId, status: status || 'active', created_at: createdAt || now(), expired_at: null, promoted_at: null })
      await wrJson(POOL_AUDIT, audit)
    }
    async function poolAuditMark(candidateId, status) {
      const audit = await rdJson(POOL_AUDIT, [])
      const row = audit.find(a => a.candidate_id === candidateId)
      if (row) {
        row.status = status
        if (status === 'promoted') row.promoted_at = now()
      }
      await wrJson(POOL_AUDIT, audit)
    }

    const TYPE_STYLE = { promotion: '🔼', demotion: '🔽', generation: '🧠', warning: '⚠️', info: 'ℹ️', success: '✅' }
    async function sendNotification(p) {
      const cfg = await loadConfig()
      if (p.type === 'warning' && !cfg.notify_on_warning) return { suppressed: true }
      if ((p.type === 'promotion' || p.type === 'demotion' || p.type === 'generation' || p.type === 'info') && !cfg.notify_on_auto_action) return { suppressed: true }
      const list = await rdJson(NOTIF, [])
      const key = p.dedupKey || (p.skillId + ':' + p.type)
      const nowMs = now()
      if (list.some(n => n.dedupKey === key && !n.dismissed && nowMs - n.created_at < 24 * 3600 * 1000)) {
        return { deduped: true }
      }
      if (isMuted(p.skillId, p.type)) return { muted: true }
      const id = 'n-' + hashStr(key + ':' + nowMs + ':' + Math.random()).slice(0, 10)
      const n = {
        id, type: p.type, skillId: p.skillId || null, title: p.title, message: p.message,
        metrics: p.metrics || [], actions: p.actions || [], dedupKey: key, reviewId: p.reviewId || null,
        ctx: p.ctx || null, created_at: nowMs, read: false, dismissed: false,
        expiresAt: p.expiresAfter ? nowMs + p.expiresAfter * 1000 : null
      }
      list.unshift(n)
      await wrJson(NOTIF, list.slice(0, 300))
      return { id }
    }
    async function listNotifications(opts) {
      const list = await rdJson(NOTIF, [])
      let out = list
      if (opts && opts.actionable) out = out.filter(n => !n.dismissed && (!n.read || n.actions.length))
      if (opts && opts.unreadOnly) out = out.filter(n => !n.read && !n.dismissed)
      return out.slice(0, opts && opts.limit || 50).map(n => ({
        id: n.id, type: n.type, icon: TYPE_STYLE[n.type] || '🔔', skillId: n.skillId, title: n.title,
        message: n.message, metrics: n.metrics, actions: n.actions, reviewId: n.reviewId,
        createdAt: n.created_at, read: n.read, dismissed: n.dismissed
      }))
    }
    async function markNotifRead(id) {
      const list = await rdJson(NOTIF, [])
      const n = list.find(x => x.id === id)
      if (n) n.read = true
      await wrJson(NOTIF, list)
      return !!n
    }
    async function markAllRead() {
      const list = await rdJson(NOTIF, [])
      for (const n of list) n.read = true
      await wrJson(NOTIF, list)
      return list.length
    }
    async function muteSkill(skillId, type, durationMs) {
      const mutes = await rdJson(MUTES, [])
      const row = mutes.find(m => m.skillId === skillId && m.type === type)
      const until = now() + (durationMs || 7 * DAY)
      if (row) row.until = until; else mutes.push({ skillId, type, until })
      await wrJson(MUTES, mutes)
      MUTES_CACHE[skillId + '|' + type] = until
      return until
    }
    function isMuted(skillId, type) {
      const mutes = MUTES_CACHE[skillId + '|' + type] || 0
      return mutes > now()
    }
    const MUTES_CACHE = {}
    async function refreshMutes() {
      const mutes = await rdJson(MUTES, [])
      for (const m of mutes) MUTES_CACHE[m.skillId + '|' + m.type] = m.until
    }

    async function recordRejection(skillName, inputHash) {
      const cfg = await loadConfig()
      const rows = await rdJson(REJECT, [])
      let row = rows.find(r => r.skill_name === skillName && r.input_hash === inputHash)
      if (!row) {
        row = { skill_name: skillName, input_hash: inputHash, reject_count: 0, first_rejected_at: now(), last_rejected_at: now() }
        rows.push(row)
      }
      row.reject_count++; row.last_rejected_at = now()
      await wrJson(REJECT, rows)
      const totalForHash = rows.filter(r => r.input_hash === inputHash).reduce((s, r) => s + r.reject_count, 0)
      return { count: totalForHash, blacklisted: totalForHash >= cfg.blocklist_threshold }
    }
    async function isInputBlacklisted(inputHash) {
      const cfg = await loadConfig()
      const rows = await rdJson(REJECT, [])
      const total = rows.filter(r => r.input_hash === inputHash).reduce((s, r) => s + r.reject_count, 0)
      return total >= cfg.blocklist_threshold
    }
    async function isSkillBlacklisted(skillName) {
      const cfg = await loadConfig()
      const rows = await rdJson(REJECT, [])
      const total = rows.filter(r => r.skill_name === skillName).reduce((s, r) => s + r.reject_count, 0)
      return total >= cfg.blocklist_threshold
    }

    async function appendReview(r) {
      const reviews = await rdJson(REVIEWS, [])
      reviews.push(r)
      await wrJson(REVIEWS, reviews)
    }
    async function reviewAction(reviewId, action) {
      const reviews = await rdJson(REVIEWS, [])
      const r = reviews.find(x => x.id === reviewId)
      if (!r) return { ok: false, reason: 'review not found' }
      if (action === 'accept') {
        r.status = 'accepted'; r.decided_at = now()
        await sendNotification({ type: 'success', skillId: r.skillName, title: 'Skill "' + r.skillName + '" 已启用', message: '生成提案已审核通过，技能已生效', actions: [{ id: 'dismiss', label: '知道了' }] })
      } else if (action === 'reject') {
        r.status = 'rejected'; r.decided_at = now()
        const s = await readWsSkill(r.wsPath, r.skillName)
        if (s) { s.meta.user_locked = true; await writeWsSkill(r.wsPath, r.skillName, s.meta, s.body) }
        const bl = await recordRejection(r.skillName, r.inputHash)
        await sendNotification({ type: 'info', skillId: r.skillName, title: '已拒收生成提案：' + r.skillName, message: bl.blacklisted ? '该诉求已进入永久黑名单（365天不再生成）' : '已记录拒绝反馈', actions: [{ id: 'dismiss', label: '知道了' }] })
      }
      await wrJson(REVIEWS, reviews)
      return { ok: true, status: r.status }
    }

    async function dirtyCheck(scope, wsPath, name) {
      const ledger = await rdJson(LEDGER, [])
      const last = ledger.filter(l => l.skillId === name).sort((a, b) => b.created_at - a.created_at)[0]
      if (!last || !last.snapshot_after) return { dirty: false, reason: null }
      const cur = scope === 'global' ? await rdText(G + '/' + name + '/SKILL.md') : await rdText(wsSkillsDir(wsPath) + '/' + name + '/SKILL.md')
      if (cur === null) return { dirty: true, reason: 'skill file missing' }
      if (hashStr(cur) !== hashStr(last.snapshot_after)) return { dirty: true, reason: 'file hash differs from ledger snapshot (manual edit detected)' }
      return { dirty: false, reason: null }
    }
    async function applyMutation(mut) {
      const cfg = await loadConfig()
      const { skillId, wsPath, patchBody, reason } = mut
      if (cfg.observer_mode_only) return { ok: false, observer: true, reason: 'observer mode: 仅观察不应用' }
      const d = await dirtyCheck('workspace', wsPath, skillId)
      if (d.dirty) {
        await sendNotification({ type: 'warning', skillId, title: '手动修改与自动进化冲突：' + skillId, message: '检测到文件哈希与账本快照不一致，自动进化已暂停，等待用户决策（覆盖/保留/对比）', actions: [{ id: 'dismiss', label: '知道了' }], dedupKey: 'dirty:' + skillId })
        return { ok: false, blocked: true, reason: d.reason }
      }
      const skill = await readWsSkill(wsPath, skillId)
      if (!skill) return { ok: false, reason: 'skill not found' }
      const oldRaw = await rdText(wsSkillsDir(wsPath) + '/' + skillId + '/SKILL.md')
      skill.meta.version = bumpVersion(skill.meta.version)
      skill.meta.updated_at = now()
      await writeWsSkill(wsPath, skillId, skill.meta, patchBody)
      await appendLedger({ skillId, action: 'evolve', reason: reason || 'auto-evolution', snapshot_before: oldRaw, snapshot_after: patchBody, operator: 'system' })
      await sendNotification({ type: 'info', skillId, title: 'Skill "' + skillId + '" 已完成自动优化迭代', message: reason || '自动演化（auto-evolve）', actions: [{ id: 'dismiss', label: '知道了' }], dedupKey: 'evolve:' + skillId })
      return { ok: true, version: skill.meta.version }
    }
    async function splitSkill(name, wsPath, trace) {
      const skill = await readWsSkill(wsPath, name)
      if (!skill) return { ok: false, reason: 'skill not found' }
      const genericSteps = []
      const specificTags = new Set()
      for (const step of (trace && trace.steps) || []) {
        const text = step.text || step.action || ''
        const isSpecific = /[A-Za-z]:[\\/]|\/Users\/|\/home\/|\.env\b|API_KEY|https?:\/\//.test(step.path || text) || !!step.env
        if (isSpecific) {
          specificTags.add('path_dependency')
          if (step.env) specificTags.add('env_specific')
        } else if (text) genericSteps.push(step)
      }
      if (genericSteps.length === 0) return { ok: false, reason: 'no generic steps extracted' }
      const genericName = name + '-generic-' + hashStr(name + now()).slice(0, 6)
      const gMeta = normalizeMeta({
        name: genericName, scope: 'workspace-only', origin_ws: wsPath, version: '1.0.0',
        auto_generated: true, coupling_tags: ['generic'], promotion_state: 'candidate', updated_at: now()
      })
      const gBody = '# description\n' + (skill.description || name) + '（通用片段，自动抽取）\n\n# instructions\n' + genericSteps.map(s => '- ' + (s.text || s.action)).join('\n') + '\n'
      await wrText(P + '/' + genericName + '/SKILL.md.generic', serializeSkill(gMeta, gBody))
      await poolAuditAppend(genericName, name, 'active', now())
      const kept = (trace.steps || []).filter(s => genericSteps.indexOf(s) === -1)
      const newBody = '# description\n' + (skill.description || name) + '\n\n# instructions\n' + (kept.length ? kept.map(s => '- ' + (s.text || s.action)).join('\n') : '（无通用步骤）') + '\n'
      skill.meta.coupling_tags = Array.from(new Set([...(skill.meta.coupling_tags || []), ...specificTags]))
      skill.meta.updated_at = now()
      await writeWsSkill(wsPath, name, skill.meta, newBody)
      await appendLedger({ skillId: name, action: 'split', reason: 'generic split', snapshot_after: newBody, operator: 'system' })
      await sendNotification({ type: 'info', skillId: name, title: '已抽取通用片段到候选池', message: '通用片段 ' + genericName + ' 已进入候选池待审核', actions: [{ id: 'dismiss', label: '知道了' }], dedupKey: 'split:' + name })
      return { ok: true, genericName, specificTags: Array.from(specificTags) }
    }

    async function findReverseDependents(name) {
      const globals = await listGlobalSkills()
      const deps = []
      for (const g of globals) {
        if (g.name === name) continue
        if ((g.body || '').indexOf(name) !== -1 || JSON.stringify(g.meta.aliases || []).indexOf(name) !== -1) deps.push(g.name)
      }
      return deps
    }
    async function checkPromotion(name, wsPath, opts) {
      const reasons = []
      const skill = wsPath ? await readWsSkill(wsPath, name) : null
      if (!skill) return { ok: false, reasons: ['workspace skill not found: ' + name], stats: null }
      const m = skill.meta
      const cfg = await loadConfig()
      if (m.scope === 'global') reasons.push('already global')
      if (m.is_bootstrap) reasons.push('bootstrap skill never evolves')
      if (m.user_locked) reasons.push('user_locked')
      if (m.forbid_promotion) reasons.push('forbid_promotion')
      if (m.auto_generated) reasons.push('auto_generated skills cannot auto-promote')
      if (m.promotion_state === 'proxy') reasons.push('proxy stub cannot promote')
      if (!cfg.allow_auto_promote) reasons.push('disabled by workspace config (allow_auto_promote=false)')
      if (cfg.observer_mode_only) reasons.push('observer mode')
      const tags = m.coupling_tags || []
      if (tags.includes('path_dependency') || tags.includes('env_specific')) reasons.push('has coupling tags: ' + tags.join(','))
      const stats = await getSkillStats(name)
      if (stats.frequencyRate < cfg.promotion_threshold) reasons.push('frequency ' + (stats.frequencyRate * 100).toFixed(4) + '% below threshold ' + (cfg.promotion_threshold * 100) + '%')
      if (stats.successRate < cfg.promotion_success_rate) reasons.push('success rate ' + (stats.successRate * 100).toFixed(1) + '% below ' + (cfg.promotion_success_rate * 100) + '%')
      if (await isSkillBlacklisted(name)) reasons.push('blacklisted by user rejections')
      if (!(opts && opts.bypassCooldown)) {
        const cool = await cooldownUntil(name)
        if (cool) reasons.push('cooldown until ' + new Date(cool).toISOString())
      }
      return { ok: reasons.length === 0, reasons, stats }
    }
    async function checkDemotion(name, wsPath, opts) {
      const reasons = []
      const skill = await readGlobalSkill(name)
      if (!skill) return { ok: false, reasons: ['global skill not found: ' + name], stats: null }
      const m = skill.meta
      const cfg = await loadConfig()
      const orig = name.endsWith('-global') ? name.slice(0, -7) : name
      if (m.is_bootstrap) reasons.push('bootstrap skill never evolves')
      if (m.user_locked) reasons.push('user_locked')
      if (m.forbid_demotion) reasons.push('forbid_demotion')
      if (!cfg.allow_auto_demote) reasons.push('disabled by workspace config (allow_auto_demote=false)')
      if (cfg.observer_mode_only) reasons.push('observer mode')
      const stats = await getSkillStats(name)
      if (stats.recentFreq > cfg.demotion_threshold || stats.oldFreq > cfg.demotion_threshold) {
        reasons.push('frequency not below threshold in both windows (recent ' + (stats.recentFreq * 100).toFixed(5) + '%, old ' + (stats.oldFreq * 100).toFixed(5) + '%)')
      }
      if (!(opts && opts.bypassCooldown)) {
        const cool = await cooldownUntil(orig)
        if (cool) reasons.push('cooldown until ' + new Date(cool).toISOString())
      }
      const deps = await findReverseDependents(name)
      if (deps.length > 0) reasons.push('reverse dependency: referenced by ' + deps.join(', '))
      return { ok: reasons.length === 0, reasons, stats }
    }
    async function executePromotion(name, wsPath, opts) {
      const chk = await checkPromotion(name, wsPath, opts)
      if (!chk.ok && !(opts && opts.force)) return { ok: false, reasons: chk.reasons }
      const skill = await readWsSkill(wsPath, name)
      if (!skill) return { ok: false, reasons: ['workspace skill not found'] }
      const snapshotBefore = await rdText(wsSkillsDir(wsPath) + '/' + name + '/SKILL.md')
      const globalName = name + '-global'
      const gMeta = normalizeMeta({
        name: globalName, scope: 'global', origin_ws: 'system',
        aliases: [...(skill.meta.aliases || []), name], version: bumpVersion(skill.meta.version),
        auto_generated: false, forbid_promotion: false, forbid_demotion: false, user_locked: skill.meta.user_locked,
        is_bootstrap: false, promotion_state: 'promoted', coupling_tags: [], updated_at: now()
      })
      await writeGlobalSkill(globalName, gMeta, skill.body)
      const stubMeta = normalizeMeta({
        name, scope: 'workspace-only', origin_ws: wsPath, aliases: skill.meta.aliases || [],
        version: skill.meta.version, auto_generated: skill.meta.auto_generated, forbid_promotion: true,
        user_locked: skill.meta.user_locked, promotion_state: 'proxy', coupling_tags: ['proxy'], updated_at: now()
      })
      const stubBody = '# description\n代理转发至全局技能 ' + globalName + '（' + nowIso() + '）\n\n# instructions\n此技能已自动升级为全局版本 ' + globalName + '，本地调用将转发至全局版本执行。\n'
      await writeWsSkill(wsPath, name, stubMeta, stubBody)
      const snapshotAfter = await rdText(G + '/' + globalName + '/SKILL.md')
      await appendLedger({ skillId: name, action: 'promote', from_scope: 'workspace', to_scope: 'global', reason: 'frequency/success thresholds met', snapshot_before: snapshotBefore, snapshot_after: snapshotAfter, operator: 'system' })
      await poolAuditMark(name, 'promoted')
      const st = chk.stats || await getSkillStats(name)
      await sendNotification({
        type: 'promotion', skillId: name, title: 'Skill "' + name + '" 已自动升级为全局版本',
        message: '30天调用占比与成功率满足升级阈值，已提升为全局技能 ' + globalName,
        metrics: [
          { label: '30天调用占比', value: ((st.frequencyRate || 0) * 100).toFixed(3) + '%', threshold: '≥0.1%' },
          { label: '成功率', value: ((st.successRate || 0) * 100).toFixed(1) + '%', threshold: '≥92%' },
          { label: '原工作区', value: '已保留代理转发 Skill', threshold: '' }
        ],
        actions: [{ id: 'rollback', label: '↩️ 一键回滚', primary: true }, { id: 'lock', label: '🔒 锁定此 Skill' }, { id: 'dismiss', label: '✕ 忽略' }],
        dedupKey: 'promotion:' + name, ctx: { wsPath }
      })
      return { ok: true, globalName, stats: st }
    }
    function threeWayMerge(base, local, remote, localIsStub) {
      if (localIsStub || local === null || local === base) return { conflict: false, content: remote }
      if (local === remote) return { conflict: false, content: local }
      return { conflict: true, base, local, remote }
    }
    async function executeDemotion(name, wsPath, opts) {
      const chk = await checkDemotion(name, wsPath, opts)
      if (!chk.ok && !(opts && opts.force)) return { ok: false, reasons: chk.reasons }
      const orig = name.endsWith('-global') ? name.slice(0, -7) : name
      const global = await readGlobalSkill(name)
      if (!global) return { ok: false, reasons: ['global skill missing'] }
      const rawGlobal = await rdText(G + '/' + name + '/SKILL.md')
      const local = await readWsSkill(wsPath, orig)
      const rawLocal = local ? await rdText(wsSkillsDir(wsPath) + '/' + orig + '/SKILL.md') : null
      const base = await getLedgerSnapshotBefore(orig, 'promote')
      const localIsStub = !!local && local.meta.promotion_state === 'proxy'
      const merged = threeWayMerge(base, rawLocal, rawGlobal, localIsStub)
      if (merged.conflict) {
        await sendNotification({ type: 'warning', skillId: orig, title: '降级冲突：' + orig, message: '全局版本与工作区版本存在冲突（用户手动修改），请手动合并', actions: [{ id: 'dismiss', label: '查看对比后处理' }], dedupKey: 'demote-conflict:' + orig })
        return { ok: false, conflict: true }
      }
      const m = normalizeMeta({
        name: orig, scope: 'workspace-only', origin_ws: wsPath,
        aliases: [...(global.meta.aliases || [])], version: bumpVersion(global.meta.version),
        auto_generated: global.meta.auto_generated, forbid_promotion: global.meta.forbid_promotion,
        user_locked: global.meta.user_locked, promotion_state: 'demoted', coupling_tags: [], updated_at: now()
      })
      await writeWsSkill(wsPath, orig, m, merged.content)
      await removeDir(G + '/' + name)
      await appendLedger({ skillId: orig, action: 'demote', from_scope: 'global', to_scope: 'workspace', reason: 'double-window frequency below threshold', snapshot_before: rawGlobal, snapshot_after: merged.content, operator: 'system' })
      const st = chk.stats || await getSkillStats(name)
      await sendNotification({
        type: 'demotion', skillId: orig, title: 'Skill "' + orig + '" 已自动降级至本项目专用',
        message: '连续两窗口调用占比低于阈值，已从全局库移除，仅当前工作区可用',
        metrics: [
          { label: '连续两窗口占比', value: ((st.recentFreq || 0) * 100).toFixed(4) + '% / ' + ((st.oldFreq || 0) * 100).toFixed(4) + '%', threshold: '≤0.01%' },
          { label: '已从全局库移除', value: '是', threshold: '' }
        ],
        actions: [{ id: 'restore', label: '↩️ 恢复全局', primary: true }, { id: 'lock', label: '🔒 锁定此 Skill' }, { id: 'dismiss', label: '✕ 忽略' }],
        dedupKey: 'demotion:' + orig, ctx: { wsPath }
      })
      return { ok: true }
    }

    async function detectMiss(request, wsPath) {
      const cfg = await loadConfig()
      const q = String(request || '').trim()
      if (!q) return { hit: false, generated: false, count: 0 }
      const hit = await resolveSkill(q, wsPath)
      if (hit) return { hit: true, generated: false, count: 0 }
      const misses = await rdJson(MISSES, [])
      const hash = hashStr(q)
      const nowMs = now()
      const recent = misses.filter(m => nowMs - m.time <= 7 * DAY)
      const similar = recent.filter(m => m.inputHash === hash || jaccard(q, m.text) >= 0.6)
      recent.push({ id: hash + ':' + recent.length + ':' + Math.random(), text: q, inputHash: hash, time: nowMs, wsPath })
      await wrJson(MISSES, recent)
      const blacklisted = await isInputBlacklisted(hash)
      if (blacklisted) return { hit: false, blacklisted: true, count: similar.length + 1, generated: false }
      if (similar.length + 1 >= cfg.auto_generate_threshold && cfg.allow_auto_generate_skill) {
        const res = await generateSkill(q, wsPath, hash)
        return { hit: false, generated: true, count: similar.length + 1, skill: res.skillName, reviewId: res.reviewId }
      }
      return { hit: false, count: similar.length + 1, generated: false }
    }
    async function uniqueWsName(wsPath, base) {
      const existing = new Set((await listWsSkills(wsPath)).map(s => s.name))
      if (!existing.has(base)) return base
      let i = 2
      while (existing.has(base + '-' + i)) i++
      return base + '-' + i
    }
    async function generateSkill(request, wsPath, inputHash) {
      const cfg = await loadConfig()
      const base = 'auto-' + (slugify(request).slice(0, 20) || hashStr(request).slice(0, 6))
      const skillName = await uniqueWsName(wsPath, base)
      const meta = normalizeMeta({
        name: skillName, scope: 'workspace-only', origin_ws: wsPath, version: '1.0.0',
        auto_generated: true, forbid_promotion: true, coupling_tags: ['generic'], promotion_state: 'none', updated_at: now()
      })
      const body = '# description\n' + request + '\n\n# instructions\n1. 分析用户诉求关键词：' + tokenize(request).join('、') + '\n2. 按照诉求执行对应操作并返回结构化结果\n3. 若执行失败，尝试替代方案并如实报告\n'
      await writeWsSkill(wsPath, skillName, meta, body)
      const reviewId = 'rev-' + hashStr(skillName + now() + Math.random()).slice(0, 8)
      await appendReview({ id: reviewId, skillName, wsPath, inputHash: inputHash || null, status: 'pending', createdAt: now(), expiresAt: now() + 7 * DAY })
      await sendNotification({
        type: 'generation', skillId: skillName, title: '检测到连续' + cfg.auto_generate_threshold + '次同类诉求，已生成新 Skill 草稿',
        message: '已根据诉求自动生成 Skill "' + skillName + '"（工作区作用域；自动生成技能不可自动升级）',
        metrics: [{ label: '触发来源', value: '连续缺失', threshold: '≥' + cfg.auto_generate_threshold + '次' }],
        actions: [{ id: 'review-accept', label: '✅ 审核通过', primary: true }, { id: 'review-reject', label: '❌ 拒绝并拒收' }, { id: 'dismiss', label: '🔇 忽略' }],
        dedupKey: 'generation:' + skillName, reviewId, ctx: { wsPath }
      })
      return { skillName, reviewId }
    }

    async function executeAction(notifId, actionId) {
      const list = await rdJson(NOTIF, [])
      const n = list.find(x => x.id === notifId)
      if (!n) return { ok: false, reason: 'notification not found' }
      if (actionId === 'dismiss') {
        n.dismissed = true; n.read = true
        await wrJson(NOTIF, list)
        if (n.skillId) await muteSkill(n.skillId, n.type, 7 * DAY)
        return { ok: true, action: 'dismissed' }
      }
      if (actionId === 'lock') {
        const target = n.skillId
        const found = await findSkillByName(target)
        let locked = 0
        if (found) {
          const s = found.skill
          s.meta.user_locked = true; s.meta.forbid_promotion = true; s.meta.forbid_demotion = true
          s.meta.updated_at = now()
          if (found.scope === 'global') { await writeGlobalSkill(s.name, s.meta, s.body); locked++ }
          else { await writeWsSkill(found.wsPath, s.name, s.meta, s.body); locked++ }
        }
        const gName = target + '-global'
        const g = await readGlobalSkill(gName)
        if (g) { g.meta.user_locked = true; g.meta.forbid_promotion = true; g.meta.forbid_demotion = true; g.meta.updated_at = now(); await writeGlobalSkill(gName, g.meta, g.body); locked++ }
        n.read = true
        await wrJson(NOTIF, list)
        await sendNotification({ type: 'info', skillId: target, title: 'Skill "' + target + '" 已锁定', message: 'user_locked=true，升级/降级/自动演化均跳过该 Skill', actions: [{ id: 'dismiss', label: '知道了' }], dedupKey: 'lock:' + target })
        return { ok: true, locked }
      }
      if (actionId === 'rollback') {
        const wsPath = (n.ctx && n.ctx.wsPath) || null
        const name = n.skillId
        const globalName = name + '-global'
        if (!wsPath) return { ok: false, reason: 'origin workspace unknown' }
        const res = await executeDemotion(globalName, wsPath, { force: true, bypassCooldown: true })
        if (res.ok) {
          n.read = true
          await wrJson(NOTIF, list)
          await sendNotification({ type: 'success', skillId: name, title: '已一键回滚：' + name, message: '全局版本已移除，工作区已恢复', actions: [{ id: 'dismiss', label: '知道了' }], dedupKey: 'rollback:' + name })
          return { ok: true, rolledBack: true }
        }
        return { ok: false, reason: res.reasons ? res.reasons.join('; ') : 'demotion failed' }
      }
      if (actionId === 'restore') {
        const wsPath = (n.ctx && n.ctx.wsPath) || null
        const name = n.skillId
        if (!wsPath) return { ok: false, reason: 'origin workspace unknown' }
        const res = await executePromotion(name, wsPath, { force: true, bypassCooldown: true })
        if (res.ok) {
          n.read = true
          await wrJson(NOTIF, list)
          return { ok: true, restored: true }
        }
        return { ok: false, reason: res.reasons ? res.reasons.join('; ') : 'promotion failed' }
      }
      if (actionId === 'review-accept' && n.reviewId) {
        const r = await reviewAction(n.reviewId, 'accept')
        n.read = true
        await wrJson(NOTIF, list)
        return { ok: r.ok, status: r.status }
      }
      if (actionId === 'review-reject' && n.reviewId) {
        const r = await reviewAction(n.reviewId, 'reject')
        n.dismissed = true; n.read = true
        await wrJson(NOTIF, list)
        return { ok: r.ok, status: r.status }
      }
      return { ok: false, reason: 'unknown action ' + actionId }
    }

    async function overview() {
      const cfg = await loadConfig()
      const globals = await listGlobalSkills()
      let wsCount = 0
      const wsList = []
      for (const ws of mounted.keys()) {
        const sk = await listWsSkills(ws)
        wsCount += sk.length
        wsList.push({ wsPath: ws, count: sk.length })
      }
      const heatmap = await getHeatmap(20, 30)
      const endangered = await getEndangeredSkills()
      const ledger = await rdJson(LEDGER, [])
      const timeline = ledger.slice(-20).reverse().map(l => ({
        id: l.id, skillId: l.skillId, action: l.action, reason: l.reason || '', operator: l.operator, createdAt: l.created_at
      }))
      const notifs = await listNotifications({ limit: 10 })
      const reviews = (await rdJson(REVIEWS, [])).filter(r => r.status === 'pending')
      const poolEntries = (await listDir(P)).filter(e => e.type === 'directory').length
      return {
        root,
        counts: { global: globals.length, workspace: wsCount, pool: poolEntries, pendingReviews: reviews.length, unread: notifs.filter(n => !n.read).length, mountedWorkspaces: mounted.size },
        workspaceList: wsList,
        heatmap, endangered, timeline,
        config: cfg,
        notifications: notifs,
        reviews: reviews.map(r => ({ id: r.id, skillName: r.skillName, wsPath: r.wsPath, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt })),
        updatedAt: nowIso()
      }
    }
    async function skillDetail(name) {
      const found = await findSkillByName(name)
      const stats = await getSkillStats(name)
      const ledger = await rdJson(LEDGER, [])
      const history = ledger.filter(l => l.skillId === name).slice(-10).reverse()
      return {
        found: !!found,
        scope: found ? found.scope : null,
        skill: found ? { name: found.skill.name, description: found.skill.description, meta: found.skill.meta } : null,
        stats,
        history: history.map(h => ({ action: h.action, reason: h.reason || '', operator: h.operator, createdAt: h.created_at })),
        poolCandidates: (await rdJson(POOL_AUDIT, [])).filter(a => a.origin_skill_id === name)
      }
    }

    async function ensureInit() {
      await wrText(G + '/.init', 'v1')
      await wrText(P + '/.init', 'v1')
      await wrText(M + '/.init', 'v1')
      if (!(await fileExists(CFG_PATH))) await wrJson(CFG_PATH, DEFAULT_CONFIG)
      await refreshMutes()
      return { root }
    }
    async function resetInstance() {
      await removeDir(root)
      await ensureInit()
      await wrJson(CALS, [])
      await wrJson(DAILY, {})
      await wrJson(LEDGER, [])
      await wrJson(NOTIF, [])
      await wrJson(REJECT, [])
      await wrJson(POOL_AUDIT, [])
      await wrJson(MISSES, [])
      await wrJson(MUTES, [])
      await wrJson(REVIEWS, [])
      return { root }
    }

    async function runSelfTest() {
      const results = []
      const T = async (id, name, fn) => {
        try {
          const r = await fn()
          results.push({ id, name, pass: !!r.pass, detail: r.detail || '' })
        } catch (e) {
          results.push({ id, name, pass: false, detail: 'EXCEPTION: ' + ((e && e.message) || String(e)) })
        }
      }
      const testRoot = root + '/test-run'
      const eng = createEngine(testRoot)
      await eng.resetInstance()
      const WS_A = testRoot + '/workspaces/ws-a'
      const WS_B = testRoot + '/workspaces/ws-b'
      const WS_C = testRoot + '/workspaces/ws-c'
      const BASE = Date.now()
      const mkSkill = async (ws, name, opts) => {
        const meta = eng.normalizeMetaPublic(Object.assign({
          name, scope: 'workspace-only', origin_ws: ws, version: '1.0.0', auto_generated: false,
          coupling_tags: [], promotion_state: 'none'
        }, opts && opts.meta))
        await eng.writeWsSkillPublic(ws, name, meta, opts && opts.body || ('# description\n' + (opts && opts.desc || name) + '\n\n# instructions\n执行 ' + name + ' 的指令。\n'))
        return meta
      }
      const mkGlobal = async (name, opts) => {
        const meta = eng.normalizeMetaPublic(Object.assign({
          name, scope: 'global', origin_ws: 'system', version: '1.0.0', auto_generated: false,
          coupling_tags: [], promotion_state: 'none'
        }, opts && opts.meta))
        await eng.writeGlobalSkillPublic(name, meta, opts && opts.body || ('# description\n' + (opts && opts.desc || name) + '\n\n# instructions\n全局技能 ' + name + ' 指令。\n'))
        return meta
      }

      await T('TC-01', '全局优先：同名 Skill 命中全局而非工作区', async () => {
        await mkSkill(WS_A, 'tc-same', { desc: '同名技能' })
        await mkGlobal('tc-same', { desc: '同名全局技能' })
        const r = await eng.resolveSkillPublic('tc-same', WS_A)
        return { pass: !!r && r.scope === 'global', detail: r ? 'resolved scope=' + r.scope : 'no hit' }
      })

      await T('TC-09', '冷启动：无任何技能时命中 Bootstrap', async () => {
        const r = await eng.resolveSkillPublic('read-file', WS_A)
        const r2 = await eng.resolveSkillPublic('search-code', WS_A)
        return { pass: !!r && r.scope === 'bootstrap' && !!r2 && r2.scope === 'bootstrap', detail: 'read-file=' + (r && r.scope) + ', search-code=' + (r2 && r2.scope) }
      })

      await T('TC-08', '命名冲突：工作区 code-format 与全局 code-format-global 互不干扰', async () => {
        await mkSkill(WS_A, 'tc-code-format', { desc: '工作区格式化' })
        await mkGlobal('tc-code-format-global', { desc: '全局格式化' })
        const a = await eng.resolveSkillPublic('tc-code-format', WS_A)
        const b = await eng.resolveSkillPublic('tc-code-format-global', WS_A)
        return { pass: !!a && a.scope === 'workspace' && !!b && b.scope === 'global', detail: 'ws-hit=' + (a && a.scope) + ', global-hit=' + (b && b.scope) }
      })

      await T('TC-02', '升级触发：占比/成功率达标 → 自动升级为全局', async () => {
        eng.setNowPublic(BASE)
        await mkSkill(WS_A, 'tc-promotable', { desc: '可升级技能', meta: { coupling_tags: [] } })
        const calls = []
        for (let i = 0; i < 150; i++) calls.push({ skillId: 'tc-promotable', scope: 'workspace', wsId: 'ws-a', success: i < 145, time: BASE - 5 * DAY + (i * 3600 * 1000) })
        for (let i = 0; i < 20000; i++) calls.push({ skillId: 'noise-skill', scope: 'workspace', success: true, time: BASE - 30 * DAY + ((30 * DAY) * (i / 20000)) })
        await eng.recordCallsBulkPublic(calls)
        const chk = await eng.checkPromotionPublic('tc-promotable', WS_A)
        if (!chk.ok) return { pass: false, detail: 'checkPromotion rejected: ' + chk.reasons.join('; ') }
        const res = await eng.executePromotionPublic('tc-promotable', WS_A)
        if (!res.ok) return { pass: false, detail: 'executePromotion failed: ' + (res.reasons || []).join('; ') }
        const g = await eng.readGlobalSkillPublic('tc-promotable-global')
        const stub = await eng.readWsSkillPublic(WS_A, 'tc-promotable')
        const ledger = await eng.getLedgerPublic('tc-promotable', 'promote')
        const notif = await eng.findNotifPublic('promotion', 'tc-promotable')
        return {
          pass: !!g && !!stub && stub.meta.promotion_state === 'proxy' && !!ledger && !!notif,
          detail: 'global=' + !!g + ', stub=' + (stub && stub.meta.promotion_state) + ', ledger=' + !!ledger + ', notif=' + !!notif
        }
      })

      await T('TC-04', '防震荡：升级后 30 天冷却期内再次变更被拒绝', async () => {
        const chk = await eng.checkPromotionPublic('tc-promotable', WS_A)
        const cool = await eng.cooldownUntilPublic('tc-promotable')
        return { pass: !!cool && chk.reasons.some(r => r.indexOf('cooldown') !== -1), detail: 'cooldownUntil=' + (cool ? new Date(cool).toISOString() : 'none') + ', reasons=' + chk.reasons.join('; ') }
      })

      await T('TC-10', '回滚：通知卡片「一键回滚」恢复原状', async () => {
        const notif = await eng.findNotifPublic('promotion', 'tc-promotable')
        const before = await eng.rdTextPublic(testRoot + '/global-skills/tc-promotable-global/SKILL.md')
        const res = await eng.executeActionPublic(notif.id, 'rollback')
        const gAfter = await eng.readGlobalSkillPublic('tc-promotable-global')
        const wsAfter = await eng.readWsSkillPublic(WS_A, 'tc-promotable')
        return {
          pass: res.ok && !gAfter && !!wsAfter && wsAfter.meta.promotion_state === 'demoted' && !!before,
          detail: 'action=' + JSON.stringify(res) + ', globalAfter=' + !!gAfter + ', wsState=' + (wsAfter && wsAfter.meta.promotion_state)
        }
      })

      await T('TC-03', '降级触发：连续两窗口占比低于阈值 → 自动降级', async () => {
        eng.setNowPublic(BASE + 40 * DAY)
        await mkSkill(WS_B, 'tc-demotable', { desc: '待降级技能', meta: { coupling_tags: [] } })
        const setupCalls = []
        for (let i = 0; i < 200; i++) setupCalls.push({ skillId: 'tc-demotable', scope: 'workspace', wsId: 'ws-b', success: true, time: BASE + 39 * DAY + i })
        for (let i = 0; i < 20000; i++) setupCalls.push({ skillId: 'noise-skill', scope: 'workspace', success: true, time: BASE + 39 * DAY + ((DAY) * (i / 20000)) })
        await eng.recordCallsBulkPublic(setupCalls)
        const promo = await eng.executePromotionPublic('tc-demotable', WS_B, { force: true, bypassCooldown: true })
        if (!promo.ok) return { pass: false, detail: 'setup promotion failed: ' + (promo.reasons || []).join('; ') }
        eng.setNowPublic(BASE + 70 * DAY)
        const lowCalls = [
          { skillId: 'tc-demotable-global', scope: 'global', wsId: 'ws-b', success: true, time: BASE + 40 * DAY },
          { skillId: 'tc-demotable-global', scope: 'global', wsId: 'ws-b', success: true, time: BASE + 62 * DAY }
        ]
        for (let i = 0; i < 30000; i++) lowCalls.push({ skillId: 'noise-skill', scope: 'workspace', success: true, time: BASE + 40 * DAY + ((30 * DAY) * (i / 30000)) })
        await eng.recordCallsBulkPublic(lowCalls)
        const chk = await eng.checkDemotionPublic('tc-demotable-global', WS_B)
        if (!chk.ok) return { pass: false, detail: 'checkDemotion rejected: ' + chk.reasons.join('; ') }
        const res = await eng.executeDemotionPublic('tc-demotable-global', WS_B)
        if (!res.ok) return { pass: false, detail: 'executeDemotion failed: ' + JSON.stringify(res) }
        const ws = await eng.readWsSkillPublic(WS_B, 'tc-demotable')
        const gAfter = await eng.readGlobalSkillPublic('tc-demotable-global')
        const ledger = await eng.getLedgerPublic('tc-demotable', 'demote')
        const notif = await eng.findNotifPublic('demotion', 'tc-demotable')
        return {
          pass: !!ws && ws.meta.promotion_state === 'demoted' && !gAfter && !!ledger && !!notif,
          detail: 'ws=' + (ws && ws.meta.promotion_state) + ', globalAfter=' + !!gAfter + ', ledger=' + !!ledger + ', notif=' + !!notif
        }
      })

      await T('TC-05', '自动生成：连续 3 次同类缺失诉求 → 生成草稿并通知', async () => {
        eng.setNowPublic(BASE + 100 * DAY)
        const r1 = await eng.detectMissPublic('帮我查一下服务器负载', WS_C)
        const r2 = await eng.detectMissPublic('帮我查一下服务器负载', WS_C)
        const r3 = await eng.detectMissPublic('帮我查一下服务器负载', WS_C)
        const list = await eng.listWsSkillsPublic(WS_C)
        const auto = list.find(s => s.name.indexOf('auto-') === 0)
        const notif = await eng.findNotifPublic('generation', auto ? auto.name : 'auto-x')
        return {
          pass: !!r3.generated && !!auto && !!notif && !!notif.reviewId,
          detail: 'r1=' + JSON.stringify(r1) + ', r2=' + JSON.stringify(r2) + ', r3=' + JSON.stringify(r3) + ', auto=' + (auto && auto.name) + ', notif=' + !!notif
        }
      })

      await T('TC-06', '负反馈闭环：同一诉求拒收 3 次后永久黑名单', async () => {
        const Q = '帮我解析这个Excel文件'
        const hash = eng.hashStrPublic(Q)
        const bl1 = await eng.recordRejectionPublic('tc-auto-test', hash)
        const bl2 = await eng.recordRejectionPublic('tc-auto-test', hash)
        const bl3 = await eng.recordRejectionPublic('tc-auto-test', hash)
        const m1 = await eng.detectMissPublic(Q, WS_C)
        const m2 = await eng.detectMissPublic(Q, WS_C)
        const m3 = await eng.detectMissPublic(Q, WS_C)
        return {
          pass: bl3.blacklisted && !!m3.blacklisted && !m3.generated,
          detail: 'rejectCount=' + bl3.count + ', blacklisted=' + bl3.blacklisted + ', m1=' + JSON.stringify(m1) + ', m2=' + JSON.stringify(m2) + ', m3=' + JSON.stringify(m3)
        }
      })

      await T('TC-07', '隔离性：A 工作区专用 Skill 在 B 工作区不可见', async () => {
        await mkSkill(WS_A, 'tc-iso-skill', { desc: '仅 A 可见' })
        eng.mountWorkspacePublic(WS_A, 'ws-a')
        const inA = await eng.resolveSkillPublic('tc-iso-skill', WS_A)
        const inB = await eng.resolveSkillPublic('tc-iso-skill', WS_B)
        const activeB = await eng.listActiveSkillsPublic(WS_B)
        return {
          pass: !!inA && inA.scope === 'workspace' && inB === null && !activeB.some(s => s.name === 'tc-iso-skill'),
          detail: 'inA=' + (inA && inA.scope) + ', inB=' + (inB ? 'hit' : 'null') + ', activeBContains=' + activeB.some(s => s.name === 'tc-iso-skill')
        }
      })

      await T('TC-11', '锁定：user_locked 后升级被拦截', async () => {
        await mkSkill(WS_A, 'tc-lockable', { desc: '可锁定技能', meta: { user_locked: true, forbid_promotion: true } })
        const chk = await eng.checkPromotionPublic('tc-lockable', WS_A)
        return { pass: chk.reasons.some(r => r.indexOf('user_locked') !== -1), detail: 'reasons=' + chk.reasons.join('; ') }
      })

      await T('TC-12', '脏检测：手动修改文件后自动进化被拦截', async () => {
        await mkSkill(WS_A, 'tc-dirty', { desc: '脏检测技能' })
        const first = await eng.applyMutationPublic({ skillId: 'tc-dirty', wsPath: WS_A, patchBody: '# description\ndirty\n\n# instructions\nv2 指令。\n', reason: 'test mutation' })
        if (!first.ok) return { pass: false, detail: 'first mutation failed: ' + JSON.stringify(first) }
        await eng.writeWsSkillPublic(WS_A, 'tc-dirty', { name: 'tc-dirty', scope: 'workspace-only', origin_ws: WS_A, version: '1.0.0', coupling_tags: [] }, '# description\ndirty\n\n# instructions\n用户手改内容。\n')
        const second = await eng.applyMutationPublic({ skillId: 'tc-dirty', wsPath: WS_A, patchBody: '# description\ndirty\n\n# instructions\nv3 指令。\n', reason: 'auto mutation after manual edit' })
        const warn = await eng.findNotifPublic('warning', 'tc-dirty')
        return {
          pass: first.ok && !!second.blocked && !!warn,
          detail: 'first=' + JSON.stringify(first) + ', second=' + JSON.stringify(second) + ', warnNotif=' + !!warn
        }
      })

      await T('TC-13', '反向依赖：被其他全局技能引用时拒绝降级', async () => {
        await mkGlobal('tc-dep-a', { desc: '依赖方', body: '# description\ndep-a\n\n# instructions\n调用 tc-dep-b-global 完成解析。\n' })
        await mkGlobal('tc-dep-b-global', { desc: '被依赖方', body: '# description\ndep-b\n\n# instructions\n解析工具。\n' })
        const chk = await eng.checkDemotionPublic('tc-dep-b-global', WS_B, { bypassCooldown: true })
        return {
          pass: chk.reasons.some(r => r.indexOf('reverse dependency') !== -1),
          detail: 'reasons=' + chk.reasons.join('; ')
        }
      })

      await T('TC-14', '三方合并：用户修改过工作区版本时降级暂停并告警', async () => {
        await mkSkill(WS_B, 'tc-conflict', { desc: '冲突技能', meta: { coupling_tags: [] } })
        const promo = await eng.executePromotionPublic('tc-conflict', WS_B, { force: true, bypassCooldown: true })
        if (!promo.ok) return { pass: false, detail: 'setup promotion failed: ' + JSON.stringify(promo) }
        await eng.writeWsSkillPublic(WS_B, 'tc-conflict', { name: 'tc-conflict', scope: 'workspace-only', origin_ws: WS_B, version: '2.0.0', promotion_state: 'workspace-only', coupling_tags: [] }, '# description\nconflict\n\n# instructions\n用户在工作区重写的内容。\n')
        const res = await eng.executeDemotionPublic('tc-conflict-global', WS_B, { force: true, bypassCooldown: true })
        const g = await eng.readGlobalSkillPublic('tc-conflict-global')
        const warn = await eng.findNotifPublic('warning', 'tc-conflict')
        return {
          pass: !!res.conflict && !!g && !!warn,
          detail: 'res=' + JSON.stringify(res) + ', globalStillExists=' + !!g + ', warn=' + !!warn
        }
      })

      await T('TC-15', '候选池 GC：超 7 天未处理的候选被清理', async () => {
        const candOld = 'tc-pool-old-' + eng.hashStrPublic('old').slice(0, 6)
        const candNew = 'tc-pool-new-' + eng.hashStrPublic('new').slice(0, 6)
        await eng.wrTextPublic(testRoot + '/promotion-pool/' + candOld + '/SKILL.md.generic', 'generic-old')
        await eng.poolAuditAppendPublic(candOld, 'tc-origin', 'active', BASE + 90 * DAY)
        await eng.wrTextPublic(testRoot + '/promotion-pool/' + candNew + '/SKILL.md.generic', 'generic-new')
        await eng.poolAuditAppendPublic(candNew, 'tc-origin2', 'active', BASE + 99 * DAY)
        eng.setNowPublic(BASE + 100 * DAY)
        const cleaned = await eng.runPromotionPoolGCPublic()
        const oldExists = await eng.fileExistsPublic(testRoot + '/promotion-pool/' + candOld + '/SKILL.md.generic')
        const newExists = await eng.fileExistsPublic(testRoot + '/promotion-pool/' + candNew + '/SKILL.md.generic')
        const audit = await eng.rdJsonPublic(testRoot + '/metrics/promotion_pool_audit.json', [])
        const oldRow = audit.find(a => a.candidate_id === candOld)
        return {
          pass: cleaned >= 1 && !oldExists && newExists && oldRow && oldRow.status === 'expired',
          detail: 'cleaned=' + cleaned + ', oldExists=' + oldExists + ', newExists=' + newExists + ', oldStatus=' + (oldRow && oldRow.status)
        }
      })

      await T('TC-16', '二分拆解：通用片段入池 + 原技能标记耦合标签', async () => {
        await mkSkill(WS_A, 'tc-mixed', { desc: '混合技能' })
        const trace = {
          steps: [
            { text: '读取配置文件并解析为 JSON' },
            { text: '解析用户输入参数' },
            { text: '读取 D:/projects/alpha/config.yaml 并应用' },
            { text: '调用 API https://api.example.com/v1/status' }
          ]
        }
        const res = await eng.splitSkillPublic('tc-mixed', WS_A, trace)
        const after = await eng.readWsSkillPublic(WS_A, 'tc-mixed')
        const poolFile = await eng.fileExistsPublic(testRoot + '/promotion-pool/' + res.genericName + '/SKILL.md.generic')
        return {
          pass: res.ok && poolFile && (after.meta.coupling_tags || []).includes('path_dependency'),
          detail: 'res=' + JSON.stringify(res) + ', poolFile=' + poolFile + ', tags=' + (after.meta.coupling_tags || []).join(',')
        }
      })

      await T('TC-17', '通知去重：24 小时内同类型不重复发送', async () => {
        const a = await eng.sendNotificationPublic({ type: 'promotion', skillId: 'tc-dedup', title: 'A', message: 'A', dedupKey: 'promotion:tc-dedup', actions: [] })
        const b = await eng.sendNotificationPublic({ type: 'promotion', skillId: 'tc-dedup', title: 'B', message: 'B', dedupKey: 'promotion:tc-dedup', actions: [] })
        const count = (await eng.rdJsonPublic(testRoot + '/metrics/notifications.json', [])).filter(n => n.dedupKey === 'promotion:tc-dedup').length
        return { pass: !!a.id && !!b.deduped && count === 1, detail: 'a=' + JSON.stringify(a) + ', b=' + JSON.stringify(b) + ', count=' + count }
      })

      await T('TC-18', '静默：用户忽略后同类通知 7 天不再打扰', async () => {
        await eng.muteSkillPublic('tc-dedup', 'promotion', 7 * 24 * 3600 * 1000)
        const r = await eng.sendNotificationPublic({ type: 'promotion', skillId: 'tc-dedup', title: 'C', message: 'C', dedupKey: 'promotion:tc-dedup-2', actions: [] })
        return { pass: !!r.muted, detail: 'r=' + JSON.stringify(r) }
      })

      await T('TC-19', '仪表盘数据：概览/热度/濒临降级/时间线可用', async () => {
        const ov = await eng.overviewPublic()
        return {
          pass: typeof ov.counts.global === 'number' && Array.isArray(ov.heatmap) && Array.isArray(ov.endangered) && Array.isArray(ov.timeline) && Array.isArray(ov.reviews),
          detail: 'global=' + ov.counts.global + ', heatmap=' + ov.heatmap.length + ', endangered=' + ov.endangered.length + ', timeline=' + ov.timeline.length + ', reviews=' + ov.reviews.length
        }
      })

      await T('TC-20', '自动生成权重衰减：auto_generated 技能频率 ×0.5', async () => {
        eng.setNowPublic(BASE + 110 * DAY)
        await mkSkill(WS_A, 'tc-auto-w', { desc: '自动技能', meta: { auto_generated: true } })
        const calls = []
        for (let i = 0; i < 100; i++) calls.push({ skillId: 'tc-auto-w', scope: 'workspace', wsId: 'ws-a', success: true, time: BASE + 108 * DAY + i })
        for (let i = 0; i < 10000; i++) calls.push({ skillId: 'noise-skill', scope: 'workspace', success: true, time: BASE + 100 * DAY + ((10 * DAY) * (i / 10000)) })
        await eng.recordCallsBulkPublic(calls)
        const st = await eng.getSkillStatsPublic('tc-auto-w')
        const expect = (100 / 10100) * 0.5
        return { pass: Math.abs(st.frequencyRate - expect) < 0.00001, detail: 'freq=' + st.frequencyRate + ' (expect≈' + expect + ')' }
      })

      await T('TC-21', '配置联动：关闭自动升级 / 观察者模式生效', async () => {
        await mkSkill(WS_A, 'tc-cfg-skill', { desc: '配置测试', meta: { coupling_tags: [] } })
        const cfgCalls = []
        for (let i = 0; i < 20; i++) cfgCalls.push({ skillId: 'tc-cfg-skill', scope: 'workspace', wsId: 'ws-a', success: true, time: BASE + 108 * DAY + i })
        await eng.recordCallsBulkPublic(cfgCalls)
        await eng.saveConfigPublic({ allow_auto_promote: false })
        const chk = await eng.checkPromotionPublic('tc-cfg-skill', WS_A)
        await eng.saveConfigPublic({ allow_auto_promote: true, observer_mode_only: true })
        const mut = await eng.applyMutationPublic({ skillId: 'tc-cfg-skill', wsPath: WS_A, patchBody: '# description\ncfg\n\n# instructions\n观察模式不应应用。\n', reason: 'observer test' })
        await eng.saveConfigPublic({ observer_mode_only: false })
        return {
          pass: chk.reasons.some(r => r.indexOf('disabled by workspace config') !== -1) && !!mut.observer,
          detail: 'chkReasons=' + chk.reasons.join('; ') + ', mut=' + JSON.stringify(mut)
        }
      })

      await T('TC-22', '通知已读：markAsRead / 全部已读', async () => {
        const list = await eng.listNotificationsPublic({})
        if (list.length === 0) return { pass: false, detail: 'no notifications' }
        await eng.markNotifReadPublic(list[0].id)
        await eng.markAllReadPublic()
        const after = await eng.listNotificationsPublic({ unreadOnly: true })
        return { pass: after.length === 0, detail: 'unreadAfter=' + after.length }
      })

      await T('TC-23', '待审核队列：审核通过 / 拒绝状态流转', async () => {
        const reviews = await eng.rdJsonPublic(testRoot + '/metrics/reviews.json', [])
        const pending = reviews.filter(r => r.status === 'pending')
        if (pending.length === 0) return { pass: false, detail: 'no pending reviews' }
        const r1 = await eng.reviewActionPublic(pending[0].id, 'accept')
        const after = await eng.rdJsonPublic(testRoot + '/metrics/reviews.json', [])
        const row = after.find(r => r.id === pending[0].id)
        return { pass: r1.ok && row.status === 'accepted', detail: 'accept=' + JSON.stringify(r1) + ', status=' + row.status }
      })

      const passed = results.filter(r => r.pass).length
      const failed = results.filter(r => !r.pass)
      return {
        total: results.length, passed, failed: failed.length,
        summary: 'PASS ' + passed + '/' + results.length,
        results
      }
    }

    return {
      now, setNow, hashStr, rdText, wrText, rdJson, wrJson, fileExists, listDir, listDirNames, removeDir,
      loadConfig, saveConfig,
      readGlobalSkill, readWsSkill, writeGlobalSkill, writeWsSkill, listGlobalSkills, listWsSkills, listActiveSkills, findSkillByName, normalizeMeta, serializeSkill,
      mountWorkspace, unmountWorkspace, isMounted, mountedKeys: () => [...mounted.keys()], resolveSkill,
      recordCall, recordCallsBulk, getSkillStats, getHeatmap, getEndangeredSkills, runDailyAggregation, runPromotionPoolGC,
      appendLedger, getLedgerSnapshotBefore, cooldownUntil, poolAuditAppend, poolAuditMark,
      dirtyCheck, applyMutation, splitSkill,
      checkPromotion, checkDemotion, executePromotion, executeDemotion, threeWayMerge, findReverseDependents,
      detectMiss, generateSkill, recordRejection,
      sendNotification, listNotifications, markNotifRead, markAllRead, muteSkill, executeAction, reviewAction,
      overview, skillDetail,
      ensureInit, resetInstance, runSelfTest,
      setNowPublic: setNow, hashStrPublic: hashStr, recordCallPublic: recordCall, recordCallsBulkPublic: recordCallsBulk, resolveSkillPublic: resolveSkill,
      checkPromotionPublic: checkPromotion, checkDemotionPublic: checkDemotion,
      executePromotionPublic: executePromotion, executeDemotionPublic: executeDemotion,
      readGlobalSkillPublic: readGlobalSkill, readWsSkillPublic: readWsSkill, writeGlobalSkillPublic: writeGlobalSkill,
      writeWsSkillPublic: writeWsSkill, listWsSkillsPublic: listWsSkills, listActiveSkillsPublic: listActiveSkills,
      mountWorkspacePublic: mountWorkspace, normalizeMetaPublic: normalizeMeta, getLedgerPublic: getLedgerSnapshotBefore,
      cooldownUntilPublic: cooldownUntil, findNotifPublic: async (type, skillId) => {
        const list = await rdJson(NOTIF, [])
        return list.find(n => n.type === type && n.skillId === skillId) || null
      },
      executeActionPublic: executeAction, recordRejectionPublic: recordRejection, detectMissPublic: detectMiss,
      applyMutationPublic: applyMutation, splitSkillPublic: splitSkill, poolAuditAppendPublic: poolAuditAppend,
      runPromotionPoolGCPublic: runPromotionPoolGC, fileExistsPublic: fileExists, rdJsonPublic: rdJson,
      wrTextPublic: wrText, rdTextPublic: rdText, sendNotificationPublic: sendNotification,
      muteSkillPublic: muteSkill, listNotificationsPublic: listNotifications, markNotifReadPublic: markNotifRead,
      markAllReadPublic: markAllRead, getSkillStatsPublic: getSkillStats, saveConfigPublic: saveConfig,
      overviewPublic: overview, reviewActionPublic: reviewAction
    }
  }

  // ------------------------------------------------------------ 装配
  const engine = createEngine(ROOT)
  await engine.ensureInit()
  const disposers = []

  // 每日聚合 + 凌晨 3 点 GC 轮询
  let lastDaily = null
  disposers.push(ctx.interval(() => {
    const d = new Date().toISOString().slice(0, 10)
    if (lastDaily !== d) {
      lastDaily = d
      engine.runDailyAggregation().catch(() => {})
      const h = new Date().getHours()
      if (h === 3) engine.runPromotionPoolGC().catch(() => {})
    }
  }, 3600000))

  // ------------------------------------------------------------ 全局工具（所有 session 的 agent 可见）
  function regTool(tool) { disposers.push(ctx.tools.register(tool)) }
  regTool(defineTool({
    name: 'evolve_status',
    description: '查看 Skill 全域自演化系统状态（计数、热度、待审核、配置、通知）',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
    },
    async execute() { return engine.overview() }
  }))
  regTool(defineTool({
    name: 'evolve_selftest',
    description: '运行 Skill 演化系统完整自验证测试套件（约 23 个典型场景），返回逐项结果',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
    },
    async execute() { return engine.runSelfTest() }
  }))
  regTool(defineTool({
    name: 'evolve_resolve',
    description: '按 引导→全局→工作区 顺序解析一个请求命中的 Skill',
    parameters: {
      query: { type: 'string', description: '用户诉求/查询文本', required: true },
      workspace: { type: 'string', description: '工作区路径（可选）' }
    },
    output: {
      schema: { type: 'json' },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
    },
    async execute(args) {
      const r = await engine.resolveSkill(args.query, args.workspace || null)
      return r ? { hit: true, scope: r.scope, name: r.skill.name, description: r.skill.description } : { hit: false }
    }
  }))
  regTool(defineTool({
    name: 'evolve_run',
    description: '执行（模拟）一个 Skill：解析命中、记录计量、返回指令摘要',
    parameters: {
      name: { type: 'string', description: 'Skill 名称', required: true },
      workspace: { type: 'string', description: '工作区路径（可选）' },
      success: { type: 'boolean', description: '执行是否成功，默认 true' }
    },
    output: {
      schema: { type: 'json' },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
    },
    async execute(args) {
      const ws = args.workspace || null
      const r = await engine.resolveSkill(args.name, ws)
      if (!r) return { hit: false }
      const rec = await engine.recordCall({ skillId: r.skill.name, scope: r.scope === 'global' ? 'global' : 'workspace', wsId: ws, success: args.success !== false, input: args.name, costTokens: 100 })
      return { hit: true, scope: r.scope, name: r.skill.name, description: r.skill.description, instructions: r.skill.body, recorded: rec.id }
    }
  }))
  regTool(defineTool({
    name: 'evolve_demo',
    description: '触发一个典型演化场景（promote/demote/generate/split/lock/rollback），用于演示与验证',
    parameters: {
      scenario: { type: 'string', description: 'promote | demote | generate | split | lock | rollback', required: true }
    },
    output: {
      schema: { type: 'json' },
      render(args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
    },
    async execute(args) { return runDemo(args.scenario || 'promote') }
  }))

  // ------------------------------------------------------------ 演示场景
  async function runDemo(scenario) {
    const demoWs = ROOT + '/workspaces/demo'
    const name = 'demo-' + scenario
    if (scenario === 'promote') {
      await engine.writeWsSkill(demoWs, name, engine.normalizeMeta({ name, scope: 'workspace-only', origin_ws: demoWs, version: '1.0.0', coupling_tags: [] }), '# description\n演示技能（可升级）\n\n# instructions\n演示自动升级流程。\n')
      const calls = []
      for (let i = 0; i < 200; i++) calls.push({ skillId: name, scope: 'workspace', wsId: 'demo', success: i < 195, time: Date.now() - i * 3600000 })
      for (let i = 0; i < 20000; i++) calls.push({ skillId: 'demo-noise', scope: 'workspace', success: true, time: Date.now() - (i % 30) * 86400000 })
      await engine.recordCallsBulk(calls)
      const res = await engine.executePromotion(name, demoWs)
      return { scenario, result: res.ok ? 'promoted to ' + res.globalName : res.reasons }
    }
    if (scenario === 'demote') {
      await engine.writeGlobalSkill(name + '-global', engine.normalizeMeta({ name: name + '-global', scope: 'global', origin_ws: 'system', version: '1.0.0' }), '# description\n演示全局技能（待降级）\n\n# instructions\n演示自动降级流程。\n')
      await engine.writeWsSkill(demoWs, name, engine.normalizeMeta({ name, scope: 'workspace-only', origin_ws: demoWs, version: '1.0.0', promotion_state: 'proxy' }), '# description\n代理 stub\n\n# instructions\n转发。\n')
      await engine.appendLedger({ skillId: name, action: 'promote', from_scope: 'workspace', to_scope: 'global', snapshot_before: '# stub', snapshot_after: '# global', operator: 'system' })
      const calls = [{ skillId: name + '-global', scope: 'global', success: true, time: Date.now() - 40 * DAY }]
      for (let i = 0; i < 20000; i++) calls.push({ skillId: 'demo-noise', scope: 'workspace', success: true, time: Date.now() - (i % 40) * 86400000 })
      await engine.recordCallsBulk(calls)
      const res = await engine.executeDemotion(name + '-global', demoWs, { force: true, bypassCooldown: true })
      return { scenario, result: res.ok ? 'demoted to workspace' : res.reasons || 'conflict' }
    }
    if (scenario === 'generate') {
      await engine.detectMiss('帮我生成项目周报', demoWs)
      await engine.detectMiss('帮我生成项目周报', demoWs)
      const r3 = await engine.detectMiss('帮我生成项目周报', demoWs)
      return { scenario, result: r3.generated ? 'generated ' + r3.skill : JSON.stringify(r3) }
    }
    if (scenario === 'split') {
      await engine.writeWsSkill(demoWs, 'demo-mixed-skill', engine.normalizeMeta({ name: 'demo-mixed-skill', scope: 'workspace-only', origin_ws: demoWs, version: '1.0.0', coupling_tags: [] }), '# description\n混合技能\n\n# instructions\n既有通用步骤也有路径步骤。\n')
      const res = await engine.splitSkill('demo-mixed-skill', demoWs, { steps: [{ text: '格式化输出 JSON' }, { text: '读取 D:/secret/config.json' }] })
      return { scenario, result: res.ok ? 'generic part -> ' + res.genericName : res.reason }
    }
    if (scenario === 'lock') {
      await engine.writeWsSkill(demoWs, 'demo-lock-skill', engine.normalizeMeta({ name: 'demo-lock-skill', scope: 'workspace-only', origin_ws: demoWs, version: '1.0.0' }), '# description\n待锁定技能\n\n# instructions\n将被锁定。\n')
      const found = await engine.findSkillByName('demo-lock-skill')
      if (found) { found.skill.meta.user_locked = true; found.skill.meta.forbid_promotion = true; found.skill.meta.forbid_demotion = true; await engine.writeWsSkill(found.wsPath, 'demo-lock-skill', found.skill.meta, found.skill.body) }
      await engine.sendNotification({ type: 'info', skillId: 'demo-lock-skill', title: 'Skill "demo-lock-skill" 已锁定', message: 'user_locked=true，升级/降级/自动演化均跳过该 Skill', actions: [{ id: 'dismiss', label: '知道了' }], dedupKey: 'lock:demo-lock-skill' })
      return { scenario, result: 'locked' }
    }
    if (scenario === 'rollback') {
      const notif = (await engine.listNotifications({})).find(n => n.type === 'promotion')
      if (!notif) return { scenario, result: 'no promotion notification to rollback' }
      const res = await engine.executeAction(notif.id, 'rollback')
      return { scenario, result: JSON.stringify(res) }
    }
    return { scenario, result: 'unknown scenario' }
  }

  // ------------------------------------------------------------ 网页仪表盘（http://127.0.0.1:3080/skill-evolve）
  const web = ctx.get('webServer')
  if (web !== undefined) {
    const json = (res, code, data) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data))
    }
    const readBody = (req) => new Promise((resolve) => {
      let d = ''
      req.on('data', (c) => { d += c })
      req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch (e) { resolve({}) } })
      req.on('error', () => resolve({}))
    })
    // 注入聊天页面的常驻 UI（通知卡片 + 技能中心入口），随 SPA index 一起下发
    const UI_JS = `(function(){
      var API='/api/skill-evolve';
      var ICON={promotion:'🔼',demotion:'🔽',generation:'🧠',warning:'⚠️',info:'ℹ️',success:'✅'};
      var root=null, hidden=false;
      function ensure(){
        if(root) return;
        var style=document.createElement('style');
        style.textContent='#skill-evolve-cards{position:fixed;right:14px;bottom:120px;z-index:9999;width:340px;max-width:calc(100vw - 28px);font-family:system-ui,sans-serif;font-size:12px;display:flex;flex-direction:column;gap:6px;pointer-events:auto}'
          +'.se-card{background:#171a23;border:1px solid #2a2e3d;border-left:3px solid #888;border-radius:8px;padding:8px 10px;color:#e6e6e6;box-shadow:0 4px 16px rgba(0,0,0,.35)}'
          +'.se-card.promotion{border-left-color:#22c55e}.se-card.demotion{border-left-color:#f59e0b}.se-card.generation{border-left-color:#3b82f6}.se-card.warning{border-left-color:#ef4444}'
          +'.se-card h4{margin:0 0 3px;font-size:12px}.se-card .se-msg{color:#aab;margin:2px 0}.se-card .se-metrics{color:#8a90a3;margin:2px 0}.se-card .se-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}'
          +'.se-btn{border:1px solid #3a3f52;background:transparent;color:#e6e6e6;border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer}.se-btn:hover{background:#232736}.se-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}'
          +'.se-head{display:flex;justify-content:space-between;align-items:center;color:#8a90a3;font-size:11px}.se-head a{color:#6ea8ff;text-decoration:none}';
        document.head.appendChild(style);
        root=document.createElement('div');
        root.id='skill-evolve-cards';
        document.body.appendChild(root);
        root.addEventListener('click', function(ev){
          var el=ev.target;
          while(el && el!==root && !(el.tagName && el.tagName.toLowerCase()==='button')) el=el.parentNode;
          if(!el || el===root) return;
          var act=el.getAttribute('data-act');
          var id=el.getAttribute('data-id');
          if(act==='hide'){hidden=true;tick();return;}
          if(act==='show'){hidden=false;tick();return;}
          if(id&&act){fetch(API+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({notificationId:id,actionId:act})}).then(function(){tick()});}
        });
      }
      function render(s){
        ensure();
        if(hidden){ root.innerHTML='<div class="se-card"><div class="se-head"><a href="/skill-evolve" target="_blank">🔧 技能演化中心</a><button class="se-btn" data-act="show">展开</button></div></div>'; return; }
        var items=(s.notifications||[]).filter(function(n){return !n.read}).slice(0,3);
        var html='<div class="se-card"><div class="se-head"><a href="/skill-evolve" target="_blank">🔧 技能演化中心</a><span>'+(items.length?items.length+' 条未读':'无通知')+' · <button class="se-btn" data-act="hide">收起</button></span></div></div>';
        items.forEach(function(n){
          html+='<div class="se-card '+n.type+'"><h4>'+ICON[n.type]+' '+n.title+'</h4>'
            +'<div class="se-msg">'+n.message+'</div>'
            +(n.metrics&&n.metrics.length?'<div class="se-metrics">'+n.metrics.map(function(m){return m.label+': '+m.value}).join(' · ')+'</div>':'')
            +'<div class="se-actions">'+(n.actions||[]).map(function(a){return '<button class="se-btn'+(a.primary?' primary':'')+'" data-act="'+a.id+'" data-id="'+n.id+'">'+a.label+'</button>'}).join('')
            +'<button class="se-btn" data-act="dismiss" data-id="'+n.id+'">✕</button></div></div>';
        });
        root.innerHTML=html;
      }
      function tick(){fetch(API+'/state').then(function(r){return r.json()}).then(render).catch(function(){})}
      setInterval(tick,5000);
      tick();
    })();`
    disposers.push(web.register({ kind: 'exact', path: '/skill-evolve/ui.js', handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end(UI_JS)
    } }))
    disposers.push(web.tapIndex((html) => {
      const script = '<script src="/skill-evolve/ui.js" defer></script>'
      return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script
    }))
    const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>技能演化中心</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f1117;color:#e6e6e6;margin:0;padding:20px}
  h1{font-size:18px} .row{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}
  .stat{background:#1a1d27;border:1px solid #2a2e3d;border-radius:8px;padding:10px 14px;min-width:100px}
  .stat b{font-size:22px;display:block} .stat span{color:#8a90a3;font-size:12px}
  .panel{background:#1a1d27;border:1px solid #2a2e3d;border-radius:8px;padding:12px;margin:10px 0}
  .panel h2{font-size:14px;margin:0 0 8px}
  .item{display:flex;justify-content:space-between;gap:8px;padding:4px 6px;border-radius:6px;font-size:13px}
  .item:hover{background:#232736}
  .bar{height:8px;background:#3b82f6;border-radius:4px;flex:1;min-width:4px}
  .tag{color:#8a90a3;font-size:11px}
  button{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px;margin:2px}
  button.ghost{background:transparent;border:1px solid #3a3f52;color:#cbd2e0}
  .demo{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
  .promotion{border-left:3px solid #22c55e}.demotion{border-left:3px solid #f59e0b}.generation{border-left:3px solid #3b82f6}.warning{border-left:3px solid #ef4444}
</style></head><body>
<h1>🔧 技能演化中心 <span class="tag" id="updated"></span></h1>
<div class="demo">
  <button onclick="demo('promote')">演示：自动升级</button><button onclick="demo('demote')">演示：自动降级</button>
  <button onclick="demo('generate')">演示：自动生成</button><button onclick="demo('split')">演示：二分拆解</button>
  <button onclick="demo('lock')">演示：锁定</button><button onclick="demo('rollback')">演示：一键回滚</button>
  <button class="ghost" onclick="runTest()">🧪 运行 23 项自验证</button>
</div>
<div class="row" id="stats"></div>
<div class="row" style="gap:10px">
  <div class="panel" style="flex:1"><h2>📊 热度排行（30天调用占比 · 含0调用技能）</h2><div id="heatmap"></div></div>
  <div class="panel" style="flex:1"><h2>⚠️ 濒临降级预警</h2><div id="endangered"></div></div>
</div>
<div class="panel"><h2>📋 演化时间线</h2><div id="timeline"></div></div>
<div class="panel"><h2>🔔 通知（可操作）</h2><div id="notifs"></div></div>
<div class="panel"><h2>📋 待审核提案</h2><div id="reviews"></div></div>
<div class="panel" id="result" style="display:none"><h2>结果</h2><pre style="white-space:pre-wrap;font-size:12px" id="resultText"></pre></div>
<script>
const ICON={promotion:'🔼',demotion:'🔽',generation:'🧠',warning:'⚠️',info:'ℹ️',success:'✅'};
function ago(t){const s=Math.floor((Date.now()-t)/1000);if(s<60)return '刚刚';if(s<3600)return Math.floor(s/60)+'分钟前';if(s<86400)return Math.floor(s/3600)+'小时前';return Math.floor(s/86400)+'天前'}
function showResult(r){document.getElementById('result').style.display='block';document.getElementById('resultText').textContent=typeof r==='string'?r:JSON.stringify(r,null,2)}
async function refresh(){
  const s=await (await fetch('/api/skill-evolve/state')).json();
  document.getElementById('updated').textContent='刷新于 '+ago(Date.parse(s.updatedAt));
  const c=s.counts;
  document.getElementById('stats').innerHTML=[['全局 Skills',c.global],['专用 Skills',c.workspace],['候选池',c.pool],['待审核',c.pendingReviews],['未读通知',c.unread]].map(x=>'<div class="stat"><b>'+x[1]+'</b><span>'+x[0]+'</span></div>').join('');
  document.getElementById('heatmap').innerHTML=(s.heatmap||[]).map(h=>'<div class="item"><span>'+h.name+'</span><div class="bar" style="width:'+Math.min(100,h.frequencyRate*6000)+'%"></div><span class="tag">'+(h.frequencyRate*100).toFixed(3)+'%</span></div>').join('')||'<div class="tag">暂无数据</div>';
  document.getElementById('endangered').innerHTML=(s.endangered||[]).map(e=>'<div class="item"><span>'+e.name+'</span><span class="tag">'+(e.frequencyRate*100).toFixed(4)+'% · '+e.status+'</span></div>').join('')||'<div class="tag">暂无</div>';
  document.getElementById('timeline').innerHTML=(s.timeline||[]).slice(0,10).map(t=>'<div class="item"><span>'+(t.action==='promote'?'🔼':t.action==='demote'?'🔽':t.action==='split'?'✂️':'🧬')+' '+t.skillId+' → '+t.action+'</span><span class="tag">'+ago(t.createdAt)+'</span></div>').join('')||'<div class="tag">暂无</div>';
  document.getElementById('notifs').innerHTML=(s.notifications||[]).map(n=>'<div class="item '+n.type+'"><span>'+ICON[n.type]+' '+n.title+'</span><span>'+(n.actions||[]).map(a=>'<button class="ghost" onclick="act(\''+n.id+'\',\''+a.id+'\')">'+a.label+'</button>').join('')+'</span></div>').join('')||'<div class="tag">暂无</div>';
  document.getElementById('reviews').innerHTML=(s.reviews||[]).map(r=>'<div class="item"><span>🧠 '+r.skillName+'</span><span><button onclick="review(\''+r.id+'\',\'accept\')">✅ 通过</button><button class="ghost" onclick="review(\''+r.id+'\',\'reject\')">❌ 拒绝</button></span></div>').join('')||'<div class="tag">暂无</div>';
}
async function act(id,action){showResult(await (await fetch('/api/skill-evolve/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({notificationId:id,actionId:action})})).json());refresh()}
async function review(id,action){showResult(await (await fetch('/api/skill-evolve/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reviewId:id,reviewAction:action})})).json());refresh()}
async function demo(s){showResult(await (await fetch('/api/skill-evolve/demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:s})})).json());refresh()}
async function runTest(){showResult(await (await fetch('/api/skill-evolve/selftest')).json())}
refresh();setInterval(refresh,5000);
</script></body></html>`
    disposers.push(web.register({ kind: 'exact', path: '/skill-evolve', handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    } }))
    disposers.push(web.register({ kind: 'exact', path: '/api/skill-evolve/state', handler: async (req, res) => {
      json(res, 200, await engine.overview())
    } }))
    disposers.push(web.register({ kind: 'exact', path: '/api/skill-evolve/action', handler: async (req, res) => {
      const body = await readBody(req)
      if (body.reviewId) json(res, 200, await engine.reviewAction(body.reviewId, body.reviewAction))
      else json(res, 200, await engine.executeAction(body.notificationId, body.actionId))
    } }))
    disposers.push(web.register({ kind: 'exact', path: '/api/skill-evolve/demo', handler: async (req, res) => {
      const body = await readBody(req)
      json(res, 200, await runDemo(body.scenario || 'promote'))
    } }))
    disposers.push(web.register({ kind: 'exact', path: '/api/skill-evolve/selftest', handler: async (req, res) => {
      json(res, 200, await engine.runSelfTest())
    } }))
  }

  return () => { for (const d of disposers) d() }
}
