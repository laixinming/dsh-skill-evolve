// ============================================================================
// Standalone verification harness for the Skill Evolution engine.
// Extracts `createEngine` from the SAME source shipped to the plugin (src/host.js),
// shims ctx (fs / subprocess) with faithful mirrors of the DSH service contracts,
// and runs the full self-test suite + main-instance demo scenarios.
// ============================================================================
'use strict';
const fsMod = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const HOST_SRC = path.join(__dirname, '..', 'src', 'host.js');
const src = fsMod.readFileSync(HOST_SRC, 'utf8');

// ---- extract createEngine function (identical code used by the plugin)
const fnStart = src.indexOf('function createEngine(root) {');
if (fnStart === -1) throw new Error('createEngine not found');
function extractBalanced(text, startIdx) {
  let i = startIdx;
  let depth = 0;
  let inStr = null;
  let escaped = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr === 'REGEX') {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '[') {
        // skip character class
        while (i < text.length && !(text[i] === ']' && text[i - 1] !== '\\')) i++;
        continue;
      }
      if (ch === '/') {
        inStr = null;
        // skip flags
        while (i + 1 < text.length && /[a-z]/i.test(text[i + 1])) i++;
      }
      continue;
    }
    if (inStr) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === '/' && canStartRegex(text, i)) {
      inStr = 'REGEX';
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  throw new Error('unbalanced createEngine braces');
}
function canStartRegex(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  return /[{(,=:!&|?;[\n]/.test(text[j]);
}
const fnSrc = extractBalanced(src, fnStart);

// ---- ctx shim: fs (resolve/stat/readText/writeText/listDir) + subprocess (spawn)
function toNative(p) { return String(p).replace(/\//g, path.sep); }
const fsShim = {
  async resolve(p) { return { key: path.resolve(toNative(p)) }; },
  async stat(t) {
    try {
      const s = await fsp.stat(t.key);
      return { type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size };
    } catch (e) { return undefined; }
  },
  async readText(t) { return await fsp.readFile(t.key, 'utf8'); },
  async writeText(t, c) {
    await fsp.mkdir(path.dirname(t.key), { recursive: true });
    await fsp.writeFile(t.key, c, 'utf8');
  },
  async listDir(t) {
    try {
      const entries = await fsp.readdir(t.key, { withFileTypes: true });
      return entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }));
    } catch (e) { return []; }
  }
};
const subShim = {
  async resolveExecutable(cmd) { return cmd; },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    return {
      done: new Promise(resolve => {
        child.on('close', code => resolve({ exitCode: code, stdout, stderr }));
        child.on('error', err => resolve({ exitCode: -1, stdout, stderr: String(err) }));
      })
    };
  }
};
const ctx = { fs: fsShim, get(name) { return name === 'subprocess' ? subShim : undefined; } };

// ---- instantiate engine
const createEngine = new Function('ctx', 'const DAY = 86400000;\n' + fnSrc + '\nreturn createEngine;')(ctx);

(async () => {
  const mode = process.argv[2] || 'selftest';
  if (mode === 'selftest') {
    const root = path.join(__dirname, '..', 'standalone-test');
    const eng = createEngine(root);
    await eng.resetInstance();
    const res = await eng.runSelfTest();
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.failed === 0 ? 0 : 1);
  } else if (mode === 'demo') {
    const root = path.join(__dirname, '..', 'standalone-demo');
    const eng = createEngine(root);
    await eng.resetInstance();
    const demoWs = root + '/workspaces/demo';
    const DAY = 86400000;
    const out = {};
    // scenario: promote
    {
      const name = 'demo-promote';
      await eng.writeWsSkill(demoWs, name, eng.normalizeMeta({ name, scope: 'workspace-only', origin_ws: demoWs, version: '1.0.0', coupling_tags: [] }), '# description\n演示技能（可升级）\n\n# instructions\n演示自动升级流程。\n');
      const calls = [];
      for (let i = 0; i < 200; i++) calls.push({ skillId: name, scope: 'workspace', wsId: 'demo', success: i < 195, time: Date.now() - i * 3600000 });
      for (let i = 0; i < 20000; i++) calls.push({ skillId: 'demo-noise', scope: 'workspace', success: true, time: Date.now() - (i % 30) * 86400000 });
      await eng.recordCallsBulk(calls);
      const res = await eng.executePromotion(name, demoWs);
      out.promote = res.ok ? 'promoted to ' + res.globalName : res.reasons;
      out.promoteGlobalExists = !!(await eng.readGlobalSkill('demo-promote-global'));
      out.promoteNotif = !!(await eng.findNotifPublic('promotion', 'demo-promote'));
    }
    // scenario: demote (on a fresh skill to avoid cooldown interplay)
    {
      const name = 'demo-demote';
      await eng.writeGlobalSkill(name + '-global', eng.normalizeMeta({ name: name + '-global', scope: 'global', origin_ws: 'system', version: '1.0.0' }), '# description\n演示全局技能（待降级）\n\n# instructions\n演示自动降级流程。\n');
      await eng.writeWsSkill(demoWs, name, eng.normalizeMeta({ name, scope: 'workspace-only', origin_ws: demoWs, version: '1.0.0', promotion_state: 'proxy' }), '# description\n代理 stub\n\n# instructions\n转发。\n');
      await eng.appendLedger({ skillId: name, action: 'promote', from_scope: 'workspace', to_scope: 'global', snapshot_before: '# stub', snapshot_after: '# global', operator: 'system' });
      const calls = [{ skillId: name + '-global', scope: 'global', success: true, time: Date.now() - 40 * DAY }];
      for (let i = 0; i < 20000; i++) calls.push({ skillId: 'demo-noise', scope: 'workspace', success: true, time: Date.now() - (i % 40) * 86400000 });
      await eng.recordCallsBulk(calls);
      const res = await eng.executeDemotion(name + '-global', demoWs, { force: true, bypassCooldown: true });
      out.demote = res.ok ? 'demoted to workspace' : (res.reasons || 'conflict');
      out.demoteWs = !!(await eng.readWsSkill(demoWs, name));
      out.demoteGlobalGone = !(await eng.readGlobalSkill(name + '-global'));
      out.demoteNotif = !!(await eng.findNotifPublic('demotion', name));
    }
    // scenario: generate (3 misses)
    {
      await eng.detectMiss('帮我生成项目周报', demoWs);
      await eng.detectMiss('帮我生成项目周报', demoWs);
      const r3 = await eng.detectMiss('帮我生成项目周报', demoWs);
      out.generate = r3.generated ? 'generated ' + r3.skill : JSON.stringify(r3);
      out.generateNotif = r3.generated ? !!(await eng.findNotifPublic('generation', r3.skill)) : false;
    }
    // scenario: split
    {
      await eng.writeWsSkill(demoWs, 'demo-mixed-skill', eng.normalizeMeta({ name: 'demo-mixed-skill', scope: 'workspace-only', origin_ws: demoWs, version: '1.0.0', coupling_tags: [] }), '# description\n混合技能\n\n# instructions\n既有通用步骤也有路径步骤。\n');
      const res = await eng.splitSkill('demo-mixed-skill', demoWs, { steps: [{ text: '格式化输出 JSON' }, { text: '读取 D:/secret/config.json' }] });
      out.split = res.ok ? 'generic -> ' + res.genericName : res.reason;
    }
    // scenario: lock
    {
      await eng.writeWsSkill(demoWs, 'demo-lock-skill', eng.normalizeMeta({ name: 'demo-lock-skill', scope: 'workspace-only', origin_ws: demoWs, version: '1.0.0' }), '# description\n待锁定技能\n\n# instructions\n将被锁定。\n');
      const found = await eng.findSkillByName('demo-lock-skill');
      if (found) { found.skill.meta.user_locked = true; found.skill.meta.forbid_promotion = true; found.skill.meta.forbid_demotion = true; await eng.writeWsSkill(found.wsPath, 'demo-lock-skill', found.skill.meta, found.skill.body); }
      const chk = await eng.checkPromotion('demo-lock-skill', demoWs);
      out.lock = 'locked, promotion blocked: ' + chk.reasons.join('; ');
    }
    // scenario: rollback via notification action
    {
      const notif = (await eng.listNotifications({})).find(n => n.type === 'promotion');
      if (notif) {
        const res = await eng.executeAction(notif.id, 'rollback');
        out.rollback = JSON.stringify(res);
      } else {
        out.rollback = 'no promotion notification found';
      }
    }
    out.overview = await eng.overview();
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  } else {
    console.error('unknown mode ' + mode);
    process.exit(2);
  }
})().catch(e => {
  console.error('FATAL:', e && e.stack || e);
  process.exit(3);
});
