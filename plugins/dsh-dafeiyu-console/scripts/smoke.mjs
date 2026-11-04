/**
 * 离线冒烟测试（无副作用）
 *
 * 不 import 目标模块、不连真实端口、不读真实配置、不写真实文件、不起进程。
 * 做法：把 index.js 源码做 ESM→CJS 化后放进 node:vm 沙箱，
 * 沙箱里的 fs / net / fetch / child_process / 定时器全是内存 fake。
 *
 * 运行：node scripts/smoke.mjs   （失败退出码 1）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { matchingProcesses, processQueryScript, killScript, sameProcess } from '../processes.mjs'
import { checkedAvatar, validCharacterId } from '../images.mjs'
import { createImportJob } from '../import_job.mjs'
import { promisify } from 'node:util'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcFile = path.join(here, '..', 'index.js')

/* ---------- 极简断言 ---------- */
const results = []
const failures = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------- 源码转换：ESM → 沙箱脚本 ---------- */
let src = readFileSync(srcFile, 'utf8')
src = src.replace(/^import\s[\s\S]*?from\s+'[^']+'\s*$/gm, '')
src = src.replace(/import\.meta\.url/g, JSON.stringify('file:///C:/fake/plugin/index.js'))
src = src.replace(/^export\s+const\s/gm, 'const ')
src = src.replace(/^export\s+function\s+apply/m, 'function apply')
src += '\n;globalThis.__apply = apply;'

/* ---------- 内存 fs ---------- */
const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase()
const files = new Map()
const dirs = new Set(['c:\\users\\tester\\.dsh'])
const deleted = []

// 内置卡目录里放一张，用于验证“内置卡不能删”
files.set(norm('C:/fake/plugin/characters/dafeiyu.json'), JSON.stringify({ id: 'dafeiyu', name: '大肥鱼' }))

const fsPromises = {
  async readFile(p) {
    const k = norm(p)
    if (!files.has(k)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return files.get(k)
  },
  async writeFile(p, data) { files.set(norm(p), String(data)) },
  async mkdir(p) { dirs.add(norm(p)) },
  async readdir(p) {
    const prefix = norm(p) + '\\'
    return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
  },
  async stat() { return { mtimeMs: 0, size: 0 } },
  async unlink(p) { deleted.push(norm(p)); files.delete(norm(p)) },
  async rename(a, b) { files.set(norm(b), files.get(norm(a))); files.delete(norm(a)) },
}
const existsSync = (p) => files.has(norm(p)) || dirs.has(norm(p))

/* ---------- 假端口 / 假网络 ---------- */
const OPEN_PORTS = new Set([6185, 6199])
class FakeSocket {
  constructor() { this.h = {} }
  setTimeout() {}
  once(ev, fn) { (this.h[ev] ||= []).push(fn); return this }
  on(ev, fn) { return this.once(ev, fn) }
  connect(port) {
    queueMicrotask(() => {
      const ev = OPEN_PORTS.has(Number(port)) ? 'connect' : 'error'
      for (const fn of (this.h[ev] || [])) fn()
    })
  }
  destroy() {}
}
const net = { Socket: FakeSocket }

/* ---------- 假子进程 ---------- */
const spawned = []
const execCalls = []
function execFile(file, args, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {} }
  execCalls.push([file, ...(args || [])])
  setImmediate(() => cb && cb(null, { stdout: 'none', stderr: '' }))
}
function spawn(file, args) {
  spawned.push([file, ...(args || [])])
  return { pid: 0, unref() {}, kill() {}, on() {}, stdout: null }
}

/* ---------- 假 fetch ---------- */
const fetchCalls = []
async function fetch(url) {
  fetchCalls.push(String(url))
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, model_loaded: true, dimensions: 512, status: 'ok', data: { token: 'fake-token' } }
    },
  }
}

/* ---------- 假定时器：只记录，不执行（防止看门狗跑起来） ---------- */
const timers = []
const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
const fakeClearTimeout = () => {}
const fakeSetInterval = (fn, ms) => { timers.push({ fn, ms, repeat: true }); return timers.length }
const fakeClearInterval = () => {}

/* ---------- 沙箱 ---------- */
const sandbox = {
  console,
  URL,
  AbortSignal: globalThis.AbortSignal,
  Buffer,
  process: { env: {}, platform: 'win32', exit() {} },
  spawn, execFile,
  createHash, randomUUID,
  matchingProcesses, processQueryScript, killScript, sameProcess, checkedAvatar, validCharacterId, createImportJob,
  createNapcatLogin: () => ({
    qr: async () => ({ loginKnown: true, loggedIn: true, hasQr: false, mtime: 0 }),
    refresh: async () => ({ alreadyLoggedIn: true }),
    png: async () => Buffer.from('fake-png'),
  }),
  promisify,
  path,
  os: { homedir: () => 'C:\\Users\\tester', tmpdir: () => 'C:\\Temp' },
  fileURLToPath,
  pathToFileURL,
  net,
  fetch,
  ...fsPromises,
  existsSync,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  queueMicrotask,
  setImmediate,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
try {
  vm.runInContext(src, sandbox, { filename: 'index.js' })
} catch (e) {
  console.error('❌ 源码在沙箱里无法加载：', e && e.message)
  process.exit(1)
}
if (typeof sandbox.__apply !== 'function') {
  console.error('❌ 没导出 apply()')
  process.exit(1)
}

/* ---------- 注册路由（仅执行注册；假定时器绝不运行看门狗） ---------- */
const routes = []
const ctx = {
  effect: (fn) => fn(), // timers are recording-only fakes; registration has no external effects
  webServer: {
    register: (r) => { routes.push(r); return () => {} },
    getOrigin: () => 'http://127.0.0.1:54321',
    port: 54321,
  },
}
sandbox.__apply(ctx, {
  bundlePath: 'C:\\fake\\bundle',
  astrbotUser: 'tester',
  astrbotPassword: 'not-a-real-password',
  astrbotPort: 6185,
})
const handler = routes[0] && routes[0].handler
check('注册了 /api/dafeiyu 路由', !!handler)

/* ---------- 请求工具 ---------- */
async function hit(method, p, headers = {}, body) {
  const res = {
    code: 0,
    headers: {},
    body: '',
    writeHead(c, h) { this.code = c; this.headers = h || {} },
    end(b) { this.body = b == null ? '' : String(b) },
  }
  const req = new EventEmitter()
  Object.assign(req, {
    method, url: '/api/dafeiyu' + p, headers,
    socket: { remoteAddress: '127.0.0.1' },
    destroy() { this.emit('aborted') },
  })
  const done = handler(req, res)
  if (body !== undefined) req.emit('data', Buffer.from(body))
  req.emit('end')
  await done
  let json = null
  try { json = JSON.parse(res.body) } catch { /* 非 JSON */ }
  return { code: res.code, json, raw: res.body }
}

const HOST = { host: '127.0.0.1:54321' }

/* ---------- 用例 ---------- */
const status = await hit('GET', '/status', HOST)
check('GET /status 返回 200', status.code === 200, `实际 ${status.code}`)
check('GET /status 是 ok:true', status.json && status.json.ok === true)
check('GET /status 带 desiredRunning', status.json && typeof status.json.data.desiredRunning === 'boolean')

const qr = await hit('GET', '/qr', HOST)
check('QQ 登录独立于 OneBot 连接', qr.json?.data?.loginKnown === true && qr.json?.data?.loggedIn === true && status.json?.data?.onebot === false)
const refresh = await hit('POST', '/qr/refresh', { ...HOST, 'x-dfy-console': '1' }, '{}')
check('原生刷新二维码不拉进程', refresh.code === 200 && refresh.json?.data?.alreadyLoggedIn === true && spawned.length === 0)

const noHost = await hit('GET', '/status', { host: 'evil.example' })
check('Host 不受信任 → 403', noHost.code === 403, `实际 ${noHost.code}`)

const noHeader = await hit('POST', '/stop', HOST, '{}')
check('POST 缺 x-dfy-console → 403', noHeader.code === 403, `实际 ${noHeader.code}`)

const badOrigin = await hit('POST', '/stop', { ...HOST, origin: 'https://evil.example', 'x-dfy-console': '1', 'content-type': 'application/json' }, '{}')
check('恶意 Origin → 403', badOrigin.code === 403, `实际 ${badOrigin.code}`)

const badProto = await hit('POST', '/stop', { ...HOST, origin: 'https://127.0.0.1:54321', 'x-dfy-console': '1', 'content-type': 'application/json' }, '{}')
check('协议不匹配的 Origin → 403', badProto.code === 403, `实际 ${badProto.code}`)

const traversal = await hit('POST', '/characters/delete', { ...HOST, 'x-dfy-console': '1', 'content-type': 'application/json' }, JSON.stringify({ id: '../../evil' }))
check('删除穿越 id → 400', traversal.code === 400, `实际 ${traversal.code}`)
check('穿越请求没有删任何文件', deleted.length === 0, `被删：${deleted.join(',')}`)

const builtin = await hit('POST', '/characters/delete', { ...HOST, 'x-dfy-console': '1', 'content-type': 'application/json' }, JSON.stringify({ id: 'dafeiyu' }))
check('删内置卡 → 403', builtin.code === 403, `实际 ${builtin.code}`)

const goodChars = await hit('GET', '/characters', HOST)
check('GET /characters 返回 200', goodChars.code === 200, `实际 ${goodChars.code}`)

/* ---------- 汇总 ---------- */
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`)
console.log(`\n${results.length - failures.length}/${results.length} 通过；副作用记录：spawn=${spawned.length} exec=${execCalls.length} fetch=${fetchCalls.length} 文件删除=${deleted.length}`)
if (failures.length) {
  console.error('\n失败项：\n- ' + failures.join('\n- '))
  process.exit(1)
}
console.log('离线冒烟通过（未触达真实文件/端口/进程/网络）')
