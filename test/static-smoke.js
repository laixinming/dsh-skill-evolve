// Static host plugin pre-restart smoke test:
//  import module → run apply(ctx) with a faithful shim → invoke the registered
//  web handlers (selftest / state / demo) to exercise the real engine code path.
'use strict'
const fsp = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')

const MOD = path.join(__dirname, '..', '..', 'profiles', 'web', 'plugins', 'skill-evolve-host', 'index.js')

;(async () => {
  const mod = await import('file:///' + MOD.replace(/\\/g, '/'))
  console.log('exports:', Object.keys(mod).join(', '))
  if (typeof mod.apply !== 'function' || mod.name !== 'skill-evolve-host') throw new Error('bad exports')

  const toNative = (p) => String(p).replace(/\//g, path.sep)
  const fsShim = {
    async resolve(p) { return { key: path.resolve(toNative(p)) } },
    async stat(t) { try { const s = await fsp.stat(t.key); return { type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other', size: s.size } } catch (e) { return undefined } },
    async readText(t) { return await fsp.readFile(t.key, 'utf8') },
    async writeText(t, c) { await fsp.mkdir(path.dirname(t.key), { recursive: true }); await fsp.writeFile(t.key, c, 'utf8') },
    async listDir(t) { try { const e = await fsp.readdir(t.key, { withFileTypes: true }); return e.map(x => ({ name: x.name, type: x.isDirectory() ? 'directory' : 'file' })) } catch (e) { return [] } }
  }
  const subShim = {
    async resolveExecutable(cmd) { return cmd },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', d => { stdout += d })
      child.stderr.on('data', d => { stderr += d })
      return { done: new Promise(resolve => { child.on('close', code => resolve({ exitCode: code, stdout, stderr })); child.on('error', err => resolve({ exitCode: -1, stdout, stderr: String(err) })) }) }
    }
  }
  const routes = new Map()
  const taps = []
  const webServerShim = {
    register(route) { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } },
    tapIndex(fn) { taps.push(fn); return () => { const at = taps.indexOf(fn); if (at !== -1) taps.splice(at, 1) } }
  }
  const registeredTools = []
  const ctx = {
    fs: fsShim,
    get(name) { return name === 'subprocess' ? subShim : name === 'webServer' ? webServerShim : undefined },
    interval(fn, ms) { const id = setInterval(fn, ms); return () => clearInterval(id) },
    tools: { register(tool) { registeredTools.push(tool.name); return () => { } } }
  }

  const disposer = await mod.apply(ctx)
  console.log('apply OK. tools:', registeredTools.join(', '), '| routes:', [...routes.keys()].join(', '))

  // fake res capturing body
  const call = (pathname, method, body) => new Promise((resolve) => {
    const chunks = []
    const res = { writeHead(code, h) { res.code = code; res.headers = h }, end(d) { if (d) chunks.push(Buffer.from(d)); resolve({ code: res.code, body: Buffer.concat(chunks).toString('utf8') }) } }
    const req = { url: pathname, method, on(ev, cb) { if (ev === 'data' && body) cb(JSON.stringify(body)); if (ev === 'end') cb(); if (ev === 'error') { } } }
    Promise.resolve(routes.get(pathname)(req, res)).catch((e) => { res.end(JSON.stringify({ error: String(e) })) })
  })

  // selftest through the real handler
  const st = await call('/api/skill-evolve/selftest', 'GET')
  const stJson = JSON.parse(st.body)
  console.log('SELFTEST:', stJson.summary, stJson.passed, '/', stJson.total)
  if (stJson.failed !== 0) { console.error(JSON.stringify(stJson.results.filter(r => !r.pass), null, 2)); throw new Error('selftest failed') }

  // state
  const state = await call('/api/skill-evolve/state', 'GET')
  const stateJson = JSON.parse(state.body)
  console.log('STATE counts:', JSON.stringify(stateJson.counts), '| heatmap:', stateJson.heatmap.length, '| timeline:', stateJson.timeline.length)
  if (typeof stateJson.counts.global !== 'number') throw new Error('state shape bad')

  // demo (lock — always safe)
  const demo = await call('/api/skill-evolve/demo', 'POST', { scenario: 'lock' })
  console.log('DEMO lock:', demo.body)

  // ui.js route + index tap
  const ui = await call('/skill-evolve/ui.js', 'GET')
  console.log('UI.JS:', ui.code, 'len', ui.body.length)
  if (ui.code !== 200 || !ui.body.includes('skill-evolve-cards')) throw new Error('ui.js bad')
  const tapped = taps.reduce((h, fn) => fn(h), '<html><body><div>app</div></body></html>')
  console.log('TAP injects script:', tapped.includes('/skill-evolve/ui.js'))
  if (!tapped.includes('/skill-evolve/ui.js')) throw new Error('tap did not inject')

  disposer()
  console.log('SMOKE PASS')
  process.exit(0)
})().catch(e => { console.error('SMOKE FAILED:', e && e.stack || e); process.exit(1) })
