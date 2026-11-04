/**
 * dsh-dafeiyu-console —— host 半边
 *
 * 干三件事：
 *   1. 读状态：NapCat(6099) / AstrBot(6185) / OneBot(6199) 端口、当前登录的 QQ、人格文件
 *   2. 启停：拉起/结束 NapCat 与 AstrBot
 *   3. 写入：人格、主人 QQ、各家 key、B站 插件配置
 *
 * 路由统一挂在 /api/dafeiyu 下，只接受本机请求。
 */

import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { matchingProcesses, processQueryScript, killScript, sameProcess } from './processes.mjs'
import { checkedAvatar, validCharacterId } from './images.mjs'
import { createImportJob } from './import_job.mjs'
import { createNapcatLogin } from './napcat_login.mjs'
import { readFile, writeFile, mkdir, readdir, stat, unlink, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'dafeiyu-console'
export const inject = ['webServer']

const HOME = os.homedir()

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function portOpen(port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, '127.0.0.1')
  })
}

const execFileP = promisify(execFile)

/** 6199 上有没有真连着的客户端：只看端口在监听不够（NapCat 没登录时连不上） */
async function onebotConnected() {
  try {
    const { stdout } = await execFileP('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return stdout.split(/\r?\n/).some((line) => /:6199\b/.test(line) && /ESTABLISHED/i.test(line))
  } catch { return false }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 本机 + 可信 Host + 同源 + 自定义请求头。
 * 可信 authority 由宿主 webServer.getOrigin()/port 延迟解析；解析不到时只允许回环主机名。
 * 同时校验 Host：DNS 重绑定的同源 GET（通常不带 Origin）会被 Host 这一关挡住。
 */
function makeGuard(resolveTrusted) {
  const LOOPBACK_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i
  return function guard(req, res, jsonFn) {
    const addr = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : ''
    if (!(addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1')) {
      jsonFn(res, 403, { ok: false, error: '只接受本机请求' })
      return false
    }
    const host = String((req.headers && req.headers.host) || '').toLowerCase()
    const trusted = resolveTrusted()
    if (!trusted) {
      jsonFn(res, 503, { ok: false, error: '宿主端口尚未就绪' })
      return false
    }
    if (!trusted.auths.has(host)) {
      jsonFn(res, 403, { ok: false, error: '请求 Host 不受信任' })
      return false
    }

    const origin = req.headers && req.headers.origin
    if (origin) {
      let u
      try { u = new URL(String(origin)) } catch {
        jsonFn(res, 403, { ok: false, error: '跨站请求被拒绝' })
        return false
      }
      // 完整 origin（含协议）必须精确匹配
      if (!trusted.origins.has(u.origin.toLowerCase())) {
        jsonFn(res, 403, { ok: false, error: '跨站请求被拒绝' })
        return false
      }
    }

    if (req.method !== 'GET' && String((req.headers && req.headers['x-dfy-console']) || '') !== '1') {
      jsonFn(res, 403, { ok: false, error: '缺少请求头 x-dfy-console' })
      return false
    }
    const ctype = String((req.headers && req.headers['content-type']) || '').split(';')[0].trim().toLowerCase()
    if (req.method !== 'GET' && ctype && ctype !== 'application/json') {
      jsonFn(res, 415, { ok: false, error: '只接受 application/json' })
      return false
    }
    return true
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0, settled = false
    const fail = (message, statusCode = 400) => {
      if (settled) return
      settled = true
      reject(Object.assign(new Error(message), { statusCode }))
    }
    req.on('data', chunk => {
      if (settled) return
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += data.length
      if (size > 2_000_000) { fail('请求体超过 2 MB', 413); req.resume?.(); return }
      chunks.push(data)
    })
    req.once('aborted', () => fail('请求已中断'))
    req.once('error', () => fail('读取请求失败'))
    req.once('end', () => {
      if (settled) return
      let value
      try { value = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }
      catch { fail('请求体不是有效 JSON'); return }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('请求体必须是 JSON 对象'); return }
      settled = true
      resolve(value)
    })
  })
}

// Only expose voice controls, never provider credentials.
function voiceView(cfg) {
  const tts = cfg.provider_tts_settings || {}
  const provider = [...(cfg.provider || []), ...(cfg.provider_sources || [])].find(p => p.id === tts.provider_id)
  const configured = !!provider && provider.enable !== false
  const supported = !(provider?.type === 'seed_audio_tts' && provider.seed_audio_whole_reply !== false)
  const raw = tts.trigger_probability
  const probability = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1
  return { configured, supported, percent: tts.enable ? Math.round(probability * 100) : 0,
    note: !supported ? '此整条语音模式有独立的概率设置，请在 AstrBot 后台调整。' :
      !configured ? '请先配置并测试语音提供商，再调整概率。' : '' }
}

function replyView(cfg) {
  const s = cfg.platform_settings?.segmented_reply || {}
  const interval = String(s.interval || '1.5,3.5').split(',').map(Number)
  const ownRange = Number.isFinite(s.dfy_interval_min_seconds) && Number.isFinite(s.dfy_interval_max_seconds)
  return {
    segmented: typeof s.dfy_segmented_enable === 'boolean' ? s.dfy_segmented_enable : !!s.enable,
    firstDelay: Number.isFinite(s.dfy_first_delay_seconds) ? s.dfy_first_delay_seconds : 0,
    minInterval: ownRange ? s.dfy_interval_min_seconds : (Number.isFinite(interval[0]) ? interval[0] : 1.5),
    maxInterval: ownRange ? s.dfy_interval_max_seconds : (Number.isFinite(interval[1]) ? interval[1] : 3.5),
    maxText: Number.isInteger(s.dfy_max_text_segments) ? s.dfy_max_text_segments : 0,
    note: !ownRange && s.interval_method === 'log' ? '当前按文字长度计算间隔；保存本面板后，私聊改用填写的秒数范围。' : '',
  }
}

function validReplySettings(body) {
  return body && typeof body.segmented === 'boolean' &&
    typeof body.firstDelay === 'number' && Number.isFinite(body.firstDelay) && body.firstDelay >= 0 && body.firstDelay <= 10 &&
    typeof body.minInterval === 'number' && Number.isFinite(body.minInterval) && body.minInterval >= 0 &&
    typeof body.maxInterval === 'number' && Number.isFinite(body.maxInterval) && body.minInterval <= body.maxInterval && body.maxInterval <= 30 &&
    typeof body.maxText === 'number' && Number.isInteger(body.maxText) && body.maxText >= 0 && body.maxText <= 10
}

export function apply(ctx, config) {
  const bundle = path.resolve(String(config.bundlePath || ''))
  const astrUser = String(config.astrbotUser || 'astrbot')
  const astrPass = String(config.astrbotPassword || '')
  const astrPort = Number(config.astrbotPort || 6185)
  const napcatLogin = createNapcatLogin({ bundle })

  const p = (...xs) => path.join(bundle, ...xs)
  const personaFile = () => p('config-pack', 'persona', '大肥鱼.md')
  const biliConfig = path.join(HOME, '.dsh', 'bili-duty', 'config.json')
  const stateFile = path.join(HOME, '.dsh', 'dafeiyu-console.json')

  // ---- 可信来源：由宿主给出协议/主机/实际端口；延迟求值，不信任请求 Host ----
  let trustedCache = null
  /** 解析宿主的真实协议/主机/端口；拿不到就返回 null（调用方失败关闭为 503） */
  function resolveTrusted() {
    if (trustedCache) return trustedCache
    let raw = ''
    let port = ''
    try {
      raw = typeof ctx.webServer?.getOrigin === 'function' ? String(ctx.webServer.getOrigin() || '') : ''
      if (raw) port = new URL(raw).port || ''
    } catch { raw = '' }
    if (!port && ctx.webServer?.port) port = String(ctx.webServer.port)
    if (!port) return null

    const auths = new Set()
    const origins = new Set()
    const add = (proto, host) => {
      auths.add(`${host}:${port}`.toLowerCase())
      origins.add(`${proto}//${host}:${port}`.toLowerCase())
    }
    const proto = raw.startsWith('https:') ? 'https:' : 'http:'
    add(proto, '127.0.0.1')
    add(proto, 'localhost')
    if (raw) {
      try { add(proto, new URL(raw).hostname) } catch { /* 忽略异常主机 */ }
    }
    trustedCache = { auths, origins, port }
    return trustedCache
  }
  const guard = makeGuard(resolveTrusted)

  // ---- 状态写入串行化（避免互相覆盖），意图持久化，操作锁 ----
  let stateTail = Promise.resolve()
  function patchState(patch) {
    const run = stateTail.then(async () => {
      await mkdir(path.dirname(stateFile), { recursive: true })
      let cur = {}
      try { cur = JSON.parse((await readFile(stateFile, 'utf8')).replace(/^\uFEFF/, '')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      const next = { ...cur, ...patch }
      const tmp = `${stateFile}.tmp`
      await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
      await rename(tmp, stateFile)
      return next
    })
    // 队列尾巴吞掉错误以继续后续写入；调用方拿到的是真实结果
    stateTail = run.catch(() => {})
    return run
  }

  let desiredRunning = null
  let intentGen = 0
  async function getDesired() {
    if (desiredRunning === null) {
      const s = await readJson(stateFile, {})
      // 读取期间可能已有新的启动/停止意图，旧磁盘快照不能覆盖它。
      if (desiredRunning === null) {
        desiredRunning = s.desiredRunning !== false
        if (Number.isFinite(Number(s.desiredGen))) intentGen = Number(s.desiredGen)
      }
    }
    return desiredRunning
  }
  /** 更新意图并返回新代号；每次启停都递增，旧操作据此失效 */
  async function setDesired(v, reason) {
    intentGen += 1
    const gen = intentGen
    desiredRunning = v
    await patchState({
      desiredRunning: v,
      desiredGen: gen,
      desiredUpdatedAt: new Date().toISOString(),
      desiredReason: reason || '',
    })
    return gen
  }
  /** 代号检查：只判断“是否已被更新的启停操作取代” */
  function ensureGen(gen, action) {
    if (gen !== intentGen) throw new Error(`${action} 已被更新的启停操作取代`)
  }
  /** 启动检查：代号仍有效 且 允许运行（停止后不得再拉起） */
  function ensureRunning(gen, action) {
    ensureGen(gen, action)
    if (desiredRunning === false) throw new Error(`${action} 已被“停止”取消`)
  }

  const importJob = createImportJob({ spawnImpl: spawn, setTimer: setTimeout, clearTimer: clearTimeout })
  let applyPending = false
  ctx.effect(() => () => importJob.cancel('控制台已卸载，导入取消'))

  let opChain = Promise.resolve()
  let opsInFlight = 0
  function withLock(fn) {
    opsInFlight++
    const run = opChain.then(fn, fn)
    opChain = run.catch(() => {})
    return run.finally(() => { opsInFlight-- })
  }
  const isOpRunning = () => opsInFlight > 0
  let opSeq = 0
  let lastOp = { id: 0, name: '', ok: null, at: 0, error: '' }
  async function runOp(name, fn) {
    const id = ++opSeq
    const started = Date.now()
    try {
      const data = await withLock(fn)
      lastOp = { id, name, ok: true, at: Date.now(), ms: Date.now() - started, error: '' }
      return { ok: true, data, op: lastOp }
    } catch (e) {
      lastOp = { id, name, ok: false, at: Date.now(), ms: Date.now() - started, error: String(e?.message || e) }
      return { ok: false, error: lastOp.error, op: lastOp }
    }
  }

  async function readJson(file, fallback) {
    try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) } catch { return fallback }
  }

  let astrToken = ''
  let astrTokenAt = 0

  async function astrLogin() {
    // AstrBot 后台限流（1 次/秒，突发 3 次），所以 token 要缓存复用
    if (astrToken && Date.now() - astrTokenAt < 10 * 60_000) return astrToken
    const r = await fetch(`http://127.0.0.1:${astrPort}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: astrUser, password: astrPass }),
    })
    const data = await r.json().catch(() => ({}))
    // 这个接口返回的是 {"status":"ok","data":{"token":...}}，不是 code:0
    const token = data?.data?.token || data?.data?.jwt || ''
    if (!token) throw new Error(data?.message || data?.status || `登录失败 HTTP ${r.status}`)
    astrToken = token
    astrTokenAt = Date.now()
    return astrToken
  }

  /** 调 AstrBot 后台接口（自动带 token） */
  async function astrApi(method, pathname, body) {    const token = await astrLogin()
    const r = await fetch(`http://127.0.0.1:${astrPort}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j?.message || `AstrBot HTTP ${r.status}`)
    return j
  }

  /** 面板里能开关的那些“能力”（都是模型可调用的函数工具） */
  const TOOL_LABELS = {
    bili_search: ['搜 B站 视频', '让它去搜关键词'],
    bili_hot: ['看 B站 热门', '主动找话题用'],
    bili_video: ['看视频详情', '标题/播放/热评'],
    set_signature: ['改 QQ 签名', '自己改个性签名'],
    llm_publish_feed: ['发 QQ 空间', '说说/动态'],
    llm_view_feed: ['看 QQ 空间', '读好友动态'],
    search_memes: ['发表情包', '从图库里挑一张'],
  }

  async function pushPersona(text) {
    const token = await astrLogin()
    const list = await fetch(`http://127.0.0.1:${astrPort}/api/personas`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((x) => x.json())
    const rows = list?.data || []
    const hit = rows.find((x) => (x.persona_id || '').includes('大肥鱼')) || rows.find((x) => x.persona_id !== 'default')
    if (!hit) throw new Error('后台里没找到可更新的人格')
    const qid = hit.id
    const r = await fetch(`http://127.0.0.1:${astrPort}/api/personas/${qid}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...hit, system_prompt: text }),
    })
    if (!r.ok) throw new Error(`更新人格失败 HTTP ${r.status}`)
    return true
  }

  /**
   * 把 QQ.exe / NapCat 的控制台窗口藏起来。
   * windowsHide 只管我们自己派生的进程；那个黑窗口是 NapCat 内部再拉起的 QQ.exe，
   * 它自己建控制台，只能在窗口出现后用 Win32 ShowWindow(SW_HIDE) 隐掉。
   */
  function hideNapcatWindows() {
    // 只藏「我们包里那个 QQ.exe」的窗口；用户自己装的 QQ（如 D:\qq\QQ.exe）绝不能碰
    const root = p('napcat').replace(/'/g, "''")
    const ps = [
      '$sig = @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class W { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); }',
      '"@',
      'Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue',
      'for ($i = 0; $i -lt 15; $i++) {',
      '  Get-Process QQ -ErrorAction SilentlyContinue |',
      `    Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '${root}\\*' } |`,
      '    ForEach-Object { [void][W]::ShowWindow($_.MainWindowHandle, 0) }',
      '  Start-Sleep -Seconds 2',
      '}',
    ].join('\r\n')
    try {
      spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref()
    } catch { /* 藏不起来也不影响运行 */ }
  }

  /**
   * 通过计划任务启动进程，让它**脱离 DSH 的作业对象**。
   * 任务名与脚本按 bundle 路径哈希隔离，避免多份安装互相覆盖。
   * VBS 只负责拉起并被 wscript 托管；启动 1.5 秒后它自己删掉任务，
   * 不再依赖“服务退出后才执行删除”。
   */
  const BUNDLE_TAG = (() => {
    try { return createHash('sha1').update(String(bundle).toLowerCase()).digest('hex').slice(0, 8) }
    catch { return 'nohash' }
  })()

  async function launchOutsideJob(exe, args, cwd, tag, logFile) {
    const task = `DSHBot-${tag}-${BUNDLE_TAG}`
    const base = path.join(HOME, '.dsh', `dsh-bot-${tag}-${BUNDLE_TAG}`)
    const cmdFile = `${base}.cmd`
    const vbsFile = `${base}.vbs`
    const redirect = logFile ? ` >> "${logFile}" 2>&1` : ''
    await mkdir(path.join(HOME, '.dsh'), { recursive: true })
    if (logFile) await mkdir(path.dirname(logFile), { recursive: true }).catch(() => {})
    await writeFile(cmdFile, [
      '@echo off',
      `cd /d "${cwd}"`,
      `"${exe}"${args.length ? ' ' + args.map((a) => `"${a}"`).join(' ') : ''}${redirect}`,
      '',
    ].join('\r\n'), 'utf8')
    await writeFile(vbsFile, [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run "cmd /c ""${cmdFile}""", 0, False`,
      'WScript.Sleep 1500',
      `sh.Run "schtasks /delete /tn ""${task}"" /f", 0, True`,
      '',
    ].join('\r\n'), 'utf8')
    const opts = { windowsHide: true }
    await execFileP('schtasks', ['/delete', '/tn', task, '/f'], opts).catch(() => {})
    await execFileP('schtasks', ['/create', '/tn', task, '/tr', `wscript.exe //B "${vbsFile}"`, '/sc', 'once', '/st', '00:00', '/f'], opts)
    await execFileP('schtasks', ['/run', '/tn', task], opts)
  }

  // ---- 各服务的“就绪”判据 ----
  // embed：只读健康接口（模型已预加载 + 固定 512 维），不再做真实 encode
  async function embedReady() {
    try {
      const h = await fetch('http://127.0.0.1:6198/health', { signal: AbortSignal.timeout(3000) })
      if (!h.ok) return false
      const hj = await h.json()
      return !!(hj && hj.ok === true && hj.model_loaded === true && Number(hj.dimensions) === 512)
    } catch { return false }
  }
  // AstrBot：新发一次 HTTP 请求（不吃 10 分钟 token 缓存），并确认 OneBot 端口在听
  async function astrbotReady() {
    try {
      const r = await fetch(`http://127.0.0.1:${astrPort}/`, { signal: AbortSignal.timeout(4000) })
      if (!r.ok) return false
      return await portOpen(6199)
    } catch { return false }
  }
  // NapCat：只看自己的 6099（6199 属于 AstrBot，绝不能在这里等）
  async function napcatReady() {
    return await portOpen(6099)
  }


  /** 服务登记表：启动/停止/就绪都走这里 */
  const services = {
    napcat: {
      port: 6099,
      exe: () => p('napcat', 'NapCat.52230.Shell', 'NapCatWinBootMain.exe'),
      cwd: () => p('napcat', 'NapCat.52230.Shell'),
      args: async () => { const { uin } = await detectQQ(); return uin ? [uin] : [] },
      log: () => p('napcat', 'napcat-console.log'),
      readyMs: 45000,
      ready: napcatReady,
      readyText: '6099 在监听',

    },
    embed: {
      port: 6198,
      exe: () => p('astrbot', 'venv', 'Scripts', 'python.exe'),
      cwd: () => p('astrbot'),
      args: () => ['-X', 'utf8', p('astrbot', 'tools', 'embed_server.py'), '--port', '6198'],
      log: () => p('astrbot', 'logs', 'embed.log'),
      readyMs: 60000,
      ready: embedReady,
      readyText: '健康检查显示模型已加载且 dimensions=512',

    },
    astrbot: {
      port: () => astrPort,
      exe: () => p('astrbot', 'venv', 'Scripts', 'astrbot.exe'),
      cwd: () => p('astrbot'),
      args: () => ['run'],
      log: () => p('astrbot', 'logs', 'live.out.log'),
      readyMs: 60000,
      ready: astrbotReady,
      readyText: '后台登录接口可用',

    },
  }
  const svcPort = (s) => (typeof s.port === 'function' ? s.port() : s.port)

  // venv 的 Windows 启动器会创建 runtime\python\python.exe，不能只匹配 venv 路径。
  const processIdentities = new Map()
  async function processSnapshot() {
    const result = await execFileP('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', processQueryScript()],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    const rows = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, '').trim() || '[]')
    return Array.isArray(rows) ? rows : rows ? [rows] : []
  }
  async function servicePids(name) {
    const rows = matchingProcesses(await processSnapshot(), bundle, name)
    for (const row of rows) processIdentities.set(row.ProcessId, row)
    return rows.map(row => row.ProcessId)
  }
  async function aliveIds(ids) {
    if (!ids.length) return []
    const current = new Map((await processSnapshot()).map(row => [Number(row.ProcessId), row]))
    return ids.filter(id => sameProcess(processIdentities.get(id), current.get(id)))
  }

  async function waitReady(s, name, gen) {
    const t0 = Date.now()
    while (Date.now() - t0 < s.readyMs) {
      if (gen !== undefined) ensureRunning(gen, `${name} 等待就绪`)
      if (await s.ready()) return true
      await new Promise((r) => setTimeout(r, 700))
    }
    return false
  }

  /** 启动：先看是否已就绪；有进程就只等不重复拉起；端口被别人占就报 occupied */
  async function startService(name, gen) {
    const s = services[name]
    if (!s) throw new Error(`未知服务 ${name}`)
    const port = svcPort(s)
    if (gen !== undefined) ensureRunning(gen, `启动 ${name}`)
    const pids = await servicePids(name)
    if (pids.length && await s.ready()) return { name, started: false, already: true, state: 'ready' }
    if (pids.length) {
      const ok = await waitReady(s, name, gen)
      if (ok) return { name, started: false, recovered: true, state: 'ready' }
      throw new Error(`${name}: 进程存在但 ${Math.round(s.readyMs / 1000)}s 内未就绪（degraded，可能仍在加载或鉴权失败）`)
    }
    if (await portOpen(port)) {
      throw new Error(`${name}: 端口 ${port} 被非本 bundle 的进程占用（occupied），未启动`)
    }

    const exe = s.exe()
    if (!existsSync(exe)) throw new Error(`${name}: 找不到 ${exe}`)
    const args = await s.args()
    if (gen !== undefined) ensureRunning(gen, `启动 ${name}`)
    await launchOutsideJob(exe, args, s.cwd(), name, s.log())
    const ok = await waitReady(s, name, gen)
    if (!ok) throw new Error(`${name}: 已提交启动，但 ${Math.round(s.readyMs / 1000)}s 内未就绪（${s.readyText}）`)
    if (name === 'napcat') hideNapcatWindows()
    return { name, started: true, state: 'ready' }
  }

  /**
   * 停止：只停 CIM 匹配到的 PID；成功标准是“这些 PID 消失 + 端口释放”，
   * 而不是 ready() 为 false（degraded 不代表进程已退出）。
   */
  async function stopService(name) {
    const s = services[name]
    if (!s) throw new Error(`未知服务 ${name}`)
    const port = svcPort(s)
    if (name === 'astrbot') { astrToken = ''; astrTokenAt = 0 }
    const pids = await servicePids(name)
    if (!pids.length) {
      if (await portOpen(port)) throw new Error(`${name}: 端口 ${port} 被占用，但没有匹配到本 bundle 的进程（occupied）`)
      return { name, stopped: true, pids: [] }
    }
    const ps = killScript(pids.map(id => processIdentities.get(id)))
    let killOut = ''
    try {
      const r = await execFileP('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true })
      killOut = String(r.stdout || '').trim()
    } catch (e) {
      throw new Error(`${name}: 停止命令失败（${e.message}）`)
    }
    if (killOut) throw new Error(`${name}: 有进程停不掉（${killOut}）`)

    const t0 = Date.now()
    while (Date.now() - t0 < 15000) {
      const alive = await aliveIds(pids)
      if (!alive.length && !(await portOpen(port))) return { name, stopped: true, pids }
      await new Promise((r) => setTimeout(r, 400))
    }
    const alive = await aliveIds(pids)
    const stillPort = await portOpen(port)
    throw new Error(`${name}: 停止超时（存活 PID: ${alive.join(',') || '无'}；端口占用: ${stillPort ? '是' : '否'}）`)
  }

  async function restartService(name, gen) {
    await stopService(name)
    return startService(name, gen)
  }

  const watchdog = { enabled: true, lastAt: 0, lastAction: '', nextTry: { napcat: 0, astrbot: 0, embed: 0 } }

  async function startAll(gen) {
    const errors = []
    for (const name of ['napcat', 'embed', 'astrbot']) {
      try {
        await startService(name, gen)
      } catch (e) {
        errors.push(`${name}: ${e.message}`)
        if (gen !== undefined && gen !== intentGen) break
      }
    }
    if (errors.length) throw new Error(errors.join('；'))
    return { ok: true }
  }

  async function stopAll(gen) {
    const errors = []
    for (const name of ['astrbot', 'embed', 'napcat']) {
      try {
        // 停止只核对“代号仍是最新”，不要求 desiredRunning 为 true
        if (gen !== undefined) ensureGen(gen, `停止 ${name}`)
        await stopService(name)
      } catch (e) {
        errors.push(`${name}: ${e.message}`)
        if (gen !== undefined && gen !== intentGen) break
      }
    }
    if (errors.length) throw new Error(errors.join('；'))
    return { ok: true }
  }

  // 面板每 2 秒轮询一次，而 netstat 要几百毫秒——缓存 1.2 秒，点按钮时再强制刷新
  let statusCache = { at: 0, data: null }
  let statusVersion = 0
  function invalidateStatus() { statusVersion++; statusCache = { at: 0, data: null } }

  async function status(force = false) {
    if (!force && statusCache.data && Date.now() - statusCache.at < 1200) return statusCache.data
    const cacheVersion = statusVersion
    const [nap, astr, onebot, embed] = await Promise.all([portOpen(6099), portOpen(astrPort), onebotConnected(), portOpen(6198)])
    const st = await readJson(stateFile, {})
    let persona = ''
    try { persona = await readFile(personaFile(), 'utf8') } catch { /* 包不在本机 */ }
    const who = await detectQQ()
    const connected = onebot
    // NapCat 即使 QQ 没登录也会连 WS，所以“在线”改由 AstrBot 的 get_login_info 探针决定
    let qqState = null
    try {
      qqState = JSON.parse(await readFile(path.join(HOME, '.dsh', 'dafeiyu-qq-state.json'), 'utf8'))
    } catch { /* 探针还没写过 */ }
    const qqFresh = !!(qqState && Date.now() - Number(qqState.at || 0) < 90_000)
    const qqOnline = !!(qqFresh && qqState.online)
    const out = {
      bundle,
      bundleOk: existsSync(bundle),
      napcat: nap,
      astrbot: astr,
      onebot,
      embed,
      connected,
      qqOnline,
      qq: qqOnline ? String(qqState.uin || who.uin || '') : '',
      qqNick: qqOnline ? String(qqState.nickname || '') : '',
      qqError: qqFresh && !qqState.online ? String(qqState.error || '') : '',
      persona,
      bili: existsSync(biliConfig),
      watchdog: { enabled: watchdog.enabled, lastAt: watchdog.lastAt, lastAction: watchdog.lastAction },
      desiredRunning: await getDesired(),
      lastOp,
    }
    if (cacheVersion === statusVersion) statusCache = { at: Date.now(), data: out }
    return out
  }

  /** 从 NapCat 的 onebot11_<QQ>.json 认出当前登录的号（不用 WS 客户端也能拿到） */
  async function detectQQ() {
    const versions = path.join(bundle, 'napcat', 'NapCat.52230.Shell', 'versions')
    let dirs = []
    try { dirs = await readdir(versions) } catch { return { uin: '', at: 0 } }
    let best = { uin: '', at: 0 }
    for (const d of dirs) {
      const cfgDir = path.join(versions, d, 'resources', 'app', 'napcat', 'config')
      let files = []
      try { files = await readdir(cfgDir) } catch { continue }
      for (const f of files) {
        const m = /^onebot11_(\d+)\.json$/.exec(f)
        if (!m) continue
        let at = 0
        try { at = (await stat(path.join(cfgDir, f))).mtimeMs } catch { /* ignore */ }
        if (at > best.at) best = { uin: m[1], at }
      }
    }
    return best
  }

  async function handle(req, res, url) {
    const route = url.pathname.replace('/api/dafeiyu', '') || '/'

    if (req.method === 'GET' && route === '/status') {
      return json(res, 200, { ok: true, data: await status(url.searchParams.has('force')) })
    }

    if (req.method === 'POST' && route === '/start') {
      invalidateStatus()
      // 先落意图，再进入操作锁；返回真实结果（不吞错）
      const gen = await setDesired(true, 'http-start')
      const r = await runOp('start', () => startAll(gen))
      invalidateStatus()
      return json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, data: { ...(r.data || {}), op: r.op } })
    }
    if (req.method === 'POST' && route === '/stop') {
      invalidateStatus()
      // 关键：先置 false，看门狗和迟到的启动立刻失效
      importJob.cancel('用户已停止，导入取消')
      const gen = await setDesired(false, 'http-stop')
      const r = await runOp('stop', () => stopAll(gen))
      invalidateStatus()
      return json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, data: { ...(r.data || {}), op: r.op } })
    }

    if (req.method === 'GET' && route === '/persona') {
      const text = await readFile(personaFile(), 'utf8').catch(() => '')
      return json(res, 200, { ok: true, data: { text } })
    }
    if (req.method === 'POST' && route === '/persona') {
      const body = await readBody(req)
      const text = String(body.text || '')
      if (!text.trim()) return json(res, 400, { ok: false, error: '人格不能为空' })
      await mkdir(path.dirname(personaFile()), { recursive: true })
      await writeFile(personaFile(), text, 'utf8')
      invalidateStatus()
      let pushed = false
      let warning = ''
      try { pushed = await pushPersona(text) } catch (e) { warning = String(e?.message || e) }
      return json(res, 200, { ok: true, data: { pushed, warning } })
    }

    if (req.method === 'GET' && route === '/config') {
      const st = await readJson(stateFile, {})
      const cfgFile = p('astrbot', 'data', 'cmd_config.json')
      let keyMasked = ''
      try {
        const raw = (await readFile(cfgFile, 'utf8')).replace(/^\uFEFF/, '')
        const cfg = JSON.parse(raw)
        const src = (cfg.provider_sources || []).find((x) => x.id === 'deepseek')
        const k = src?.key?.[0] || ''
        keyMasked = k ? `${k.slice(0, 6)}…${k.slice(-4)}` : ''
      } catch { /* 忽略 */ }
      return json(res, 200, { ok: true, data: { ownerQQ: st.ownerQQ || '', deepseekKeyMasked: keyMasked } })
    }
    if (req.method === 'POST' && route === '/config') {
      const body = await readBody(req)
      // 串行化写入，避免和 desiredRunning 等字段互相覆盖
      if (body.ownerQQ) await patchState({ ownerQQ: String(body.ownerQQ) })

      if (body.deepseekKey) {
        const cfgFile = p('astrbot', 'data', 'cmd_config.json')
        const raw = (await readFile(cfgFile, 'utf8')).replace(/^\uFEFF/, '')
        const cfg = JSON.parse(raw)
        for (const s of cfg.provider_sources || []) if (s.id === 'deepseek') s.key = [String(body.deepseekKey)]
        await writeFile(cfgFile, JSON.stringify(cfg, null, 2), 'utf8')
        // 磁盘改了，但运行中的 provider 仍是旧 key；明确告知需要重启
        return json(res, 200, { ok: true, data: { needRestart: true } })
      }
      return json(res, 200, { ok: true, data: { needRestart: false } })
    }

    if (req.method === 'GET' && route === '/reply-settings') {
      const cfg = await readJson(p('astrbot', 'data', 'cmd_config.json'), null)
      if (!cfg) return json(res, 400, { ok: false, error: '无法读取 AstrBot 配置' })
      return json(res, 200, { ok: true, data: replyView(cfg) })
    }
    if (req.method === 'POST' && route === '/reply-settings') {
      const body = await readBody(req)
      if (!validReplySettings(body)) return json(res, 400, { ok: false,
        error: '首条等待须为0–10秒；段间等待须满足0≤最小≤最大≤30秒；最多文字条数须为0–10的整数' })
      const r = await runOp('reply-settings', async () => {
        const cfgFile = p('astrbot', 'data', 'cmd_config.json')
        const cfg = await readJson(cfgFile, null)
        if (!cfg) throw new Error('无法读取 AstrBot 配置，未修改')
        const ps = cfg.platform_settings || (cfg.platform_settings = {})
        const s = ps.segmented_reply || (ps.segmented_reply = {})
        const patch = { dfy_managed_reply_settings: true,
          dfy_segmented_enable: body.segmented, dfy_first_delay_seconds: body.firstDelay,
          dfy_interval_min_seconds: body.minInterval, dfy_interval_max_seconds: body.maxInterval,
          dfy_max_text_segments: body.maxText }
        if (Object.entries(patch).every(([key, value]) => s[key] === value)) {
          return { ...replyView(cfg), changed: false, restarted: false }
        }
        Object.assign(s, patch)
        const pending = `${cfgFile}.reply-${randomUUID()}.tmp`
        try {
          await writeFile(pending, JSON.stringify(cfg, null, 2), { encoding: 'utf8', flag: 'wx' })
          await rename(pending, cfgFile)
        } finally { await unlink(pending).catch(() => {}) }
        const wanted = await getDesired()
        const gen = intentGen
        try {
          if (wanted) { await stopService('astrbot'); await startService('astrbot', gen) }
        } catch { throw new Error('回复节奏已保存，但 AstrBot 重启未完成；请检查服务状态，无需重新扫码') }
        const saved = await readJson(cfgFile, null)
        const savedReply = saved?.platform_settings?.segmented_reply
        if (!savedReply || !Object.entries(patch).every(([key, value]) => savedReply[key] === value)) {
          throw new Error('回复节奏未能在重启后保留，未判定为保存成功；请保留当前错误提示')
        }
        return { ...replyView(saved), changed: true, restarted: wanted }
      })
      invalidateStatus()
      return json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, data: { ...(r.data || {}), op: r.op } })
    }

    if (req.method === 'GET' && route === '/voice') {
      const cfg = await readJson(p('astrbot', 'data', 'cmd_config.json'), null)
      if (!cfg) return json(res, 400, { ok: false, error: '无法读取 AstrBot 配置' })
      return json(res, 200, { ok: true, data: voiceView(cfg) })
    }
    if (req.method === 'POST' && route === '/voice') {
      const body = await readBody(req)
      const percent = body?.percent
      if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100) {
        return json(res, 400, { ok: false, error: '语音概率必须是 0–100 的整数' })
      }
      const r = await runOp('voice-settings', async () => {
        const cfgFile = p('astrbot', 'data', 'cmd_config.json')
        const cfg = await readJson(cfgFile, null)
        if (!cfg) throw new Error('无法读取 AstrBot 配置，未修改')
        const view = voiceView(cfg)
        if (!view.supported || (!view.configured && percent > 0)) throw new Error(view.note)
        const tts = cfg.provider_tts_settings || (cfg.provider_tts_settings = {})
        const enabled = percent > 0
        if (tts.trigger_probability === percent / 100 && tts.enable === enabled) {
          return { ...voiceView(cfg), changed: false, restarted: false }
        }
        tts.trigger_probability = percent / 100
        tts.enable = enabled
        const pending = `${cfgFile}.voice-${randomUUID()}.tmp`
        try {
          await writeFile(pending, JSON.stringify(cfg, null, 2), { encoding: 'utf8', flag: 'wx' })
          await rename(pending, cfgFile)
        } finally { await unlink(pending).catch(() => {}) }
        const wanted = await getDesired()
        const gen = intentGen
        try {
          if (wanted) {
            await stopService('astrbot')
            await startService('astrbot', gen)
          }
        } catch {
          throw new Error('语音概率已保存，但 AstrBot 重启未完成；请检查服务状态，无需重新扫码')
        }
        return { ...voiceView(cfg), changed: true, restarted: wanted }
      })
      invalidateStatus()
      return json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, data: { ...(r.data || {}), op: r.op } })
    }

    if (req.method === 'GET' && route === '/bili') {
      const cfg = await readJson(biliConfig, null)
      return json(res, 200, { ok: true, data: cfg ? {
        exists: true,
        dmUid: cfg.dmUid ?? 0,
        perDay: cfg.perDay ?? 5,
        autoComment: !!cfg.autoComment,
        keywords: cfg.keywords || [],
        loggedIn: !!(cfg.credential || cfg.loggedIn),
      } : { exists: false } })
    }
    if (req.method === 'POST' && route === '/bili') {
      const body = await readBody(req)
      const cfg = await readJson(biliConfig, null)
      if (!cfg) return json(res, 400, { ok: false, error: '本机没有 B站 插件配置' })
      if (body.dmUid !== undefined) cfg.dmUid = Number(body.dmUid) || 0
      if (body.perDay !== undefined) cfg.perDay = Math.max(1, Math.min(20, Number(body.perDay) || 5))
      if (body.autoComment !== undefined) cfg.autoComment = !!body.autoComment
      if (Array.isArray(body.keywords)) cfg.keywords = body.keywords.map(String).filter(Boolean)
      await writeFile(biliConfig, JSON.stringify(cfg, null, 2), 'utf8')
      return json(res, 200, { ok: true })
    }

    if (req.method === 'POST' && route === '/loaded') {
      const body = await readBody(req)
      await writeFile(
        path.join(HOME, '.dsh', 'dafeiyu-console.loaded.json'),
        JSON.stringify({ at: new Date().toISOString(), ...body }, null, 2),
        'utf8',
      ).catch(() => {})
      return json(res, 200, { ok: true })
    }

    const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
  const presetCharDir = path.join(PLUGIN_DIR, 'characters')
  const userCharDir = path.join(HOME, '.dsh', 'dafeiyu-console', 'characters')

  const biliDir = path.join(HOME, '.dsh', 'bili-duty')
  const biliQrState = path.join(HOME, '.dsh', 'dafeiyu-console.bili-qr.json')
  const biliPythonPath = () => path.join(biliDir, '.venv', 'Scripts', 'python.exe')

  /** 复用刷B站插件的登录模块（出码/轮询/存凭证） */
  async function loadBiliLogin() {
    for (const prof of ['desktop', 'web', 'headless']) {
      const f = path.join(HOME, '.dsh', 'profiles', prof, 'node_modules', 'dsh-bili-scroll', 'lib', 'login.mjs')
      if (!existsSync(f)) continue
      try { return await import(pathToFileURL(f).href) } catch { /* 换下一个 profile */ }
    }
    return null
  }

  async function listCharacters() {
    const out = []
    for (const dir of [presetCharDir, userCharDir]) {
      let names = []
      try { names = await readdir(dir) } catch { continue }
      for (const n of names) {
        if (!n.endsWith('.json')) continue
        try {
          const c = JSON.parse(await readFile(path.join(dir, n), 'utf8'))
          out.push({ ...c, id: c.id || n.replace(/\.json$/, ''), builtin: dir === presetCharDir })
        } catch { /* 跳过坏文件 */ }
      }
    }
    // 原版（order=0）排最前，其余按 order / 名字
    out.sort((a, b) => {
      const oa = Number.isFinite(Number(a.order)) ? Number(a.order) : 99
      const ob = Number.isFinite(Number(b.order)) ? Number(b.order) : 99
      if (oa !== ob) return oa - ob
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
    })
    return out
  }

  async function findCharacter(id) {
    const all = await listCharacters()
    return all.find((c) => c.id === id) || null
  }

  // ── 从当前 NapCat 查询登录态/二维码；不把 OneBot 连接误当作 QQ 登录。
  if (req.method === 'GET' && route === '/qr') {
    return json(res, 200, { ok: true, data: await napcatLogin.qr() })
  }

  if (req.method === 'GET' && route === '/qr.png') {
    try {
      const buf = await napcatLogin.png()
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(buf)
    } catch (error) {
      json(res, 503, { ok: false, error: error.message })
    }
    return
  }

  // 原生出码接口不会重启 QQ；单独保留显式换号的重启入口。
  if (req.method === 'POST' && route === '/qr/refresh') {
    const body = await readBody(req)
    const r = await runOp('qr-refresh', () => napcatLogin.refresh({ afterRecovery: body.afterRecovery === true }))
    invalidateStatus()
    return json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, data: r.data })
  }

  // ── 仅供用户明确确认“换个号”使用。
  if (req.method === 'POST' && route === '/qr/restart') {
    const r = await runOp('qr-restart', async () => {
      const gen = await setDesired(true, 'qr-restart')
      await restartService('napcat', gen)
      return { ok: true }
    })
    invalidateStatus()
    return json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, data: { ...(r.data || {}), op: r.op } })
  }

  // ── B站 二维码：复用刷B站插件的 lib/login.mjs（同一套出码/轮询/存凭证）
  if (req.method === 'GET' && route === '/bili/qr') {
    const png = path.join(biliDir, 'qrcode_login.png')
    let mtime = 0
    try { mtime = (await stat(png)).mtimeMs } catch { /* 还没有 */ }
    return json(res, 200, {
      ok: true,
      data: {
        installed: existsSync(path.join(biliDir, 'config.json')),
        loggedIn: existsSync(path.join(biliDir, 'bili_credential.json')),
        hasQr: existsSync(png),
        mtime,
      },
    })
  }

  if (req.method === 'POST' && route === '/bili/qr/start') {
    const mod = await loadBiliLogin()
    if (!mod) return json(res, 400, { ok: false, error: '没找到刷B站插件（dsh-bili-scroll）' })
    await mkdir(biliDir, { recursive: true })
    const { key, url } = await mod.loginStart()
    await writeFile(biliQrState, JSON.stringify({ key, url, at: Date.now() }), 'utf8').catch(() => {})
    const png = await mod.renderQrPng(biliPythonPath(), biliDir, url)
    if (!png) return json(res, 500, { ok: false, error: '画二维码失败（刷B站插件的 venv 里缺 qrcode 包）' })
    let mtime = 0
    try { mtime = (await stat(png)).mtimeMs } catch { /* ignore */ }
    return json(res, 200, { ok: true, data: { hasQr: true, mtime } })
  }

  if (req.method === 'GET' && route === '/bili/qr.png') {
    const png = path.join(biliDir, 'qrcode_login.png')
    try {
      const buf = await readFile(png)
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(buf)
    } catch { json(res, 404, { ok: false, error: '还没有二维码' }) }
    return
  }

  if (req.method === 'POST' && route === '/bili/qr/poll') {
    const mod = await loadBiliLogin()
    if (!mod) return json(res, 400, { ok: false, error: '没找到刷B站插件' })
    const st = await readJson(biliQrState, {})
    if (!st.key) return json(res, 400, { ok: false, error: '还没有生成过二维码' })
    const r = await mod.loginPoll(st.key)
    if (r.state === 'ok') {
      mod.saveCredential(biliDir, r.credential)
      return json(res, 200, { ok: true, data: { state: 'ok' } })
    }
    return json(res, 200, { ok: true, data: { state: r.state, message: r.message || '' } })
  }

  // ── 主动消息（私聊那一套参数）
  if (req.method === 'GET' && route === '/proactive') {
    const f = p('astrbot', 'data', 'config', 'astrbot_plugin_proactive_chat_config.json')
    const cfg = await readJson(f, null)
    const fs_ = cfg?.friend_settings || {}
    const sch = fs_.schedule_settings || {}
    return json(res, 200, {
      ok: true,
      data: {
        installed: !!cfg,
        enable: !!fs_.enable,
        afterMinutes: fs_.auto_trigger_settings?.auto_trigger_after_minutes ?? 5,
        minInterval: sch.min_interval_minutes ?? 30,
        maxInterval: sch.max_interval_minutes ?? 600,
        quietHours: sch.quiet_hours ?? '1-7',
        maxUnanswered: sch.max_unanswered_times ?? 4,
      },
    })
  }

  if (req.method === 'POST' && route === '/proactive') {
    const f = p('astrbot', 'data', 'config', 'astrbot_plugin_proactive_chat_config.json')
    const cfg = await readJson(f, null)
    if (!cfg) return json(res, 400, { ok: false, error: '本机没有主动消息插件的配置' })
    const body = await readBody(req)
    const fs_ = cfg.friend_settings || (cfg.friend_settings = {})
    if (body.enable !== undefined) fs_.enable = !!body.enable
    const at = fs_.auto_trigger_settings || (fs_.auto_trigger_settings = {})
    if (body.afterMinutes !== undefined) at.auto_trigger_after_minutes = Math.max(1, Number(body.afterMinutes) || 5)
    const sch = fs_.schedule_settings || (fs_.schedule_settings = {})
    if (body.minInterval !== undefined) sch.min_interval_minutes = Math.max(5, Number(body.minInterval) || 30)
    if (body.maxInterval !== undefined) sch.max_interval_minutes = Math.max(10, Number(body.maxInterval) || 600)
    if (body.quietHours !== undefined) sch.quiet_hours = String(body.quietHours || '')
    if (body.maxUnanswered !== undefined) sch.max_unanswered_times = Math.max(0, Number(body.maxUnanswered) || 0)
    await writeFile(f, JSON.stringify(cfg, null, 2), 'utf8')

    // 插件配置在启动时读进内存，改完得让 AstrBot 重载（统一走启动器 + 操作锁）
    const r = await runOp('proactive-restart', async () => {
      const gen = intentGen
      const wanted = desiredRunning !== false
      await stopService('astrbot')
      if (wanted) await startService('astrbot', gen)
      return { restarted: wanted }
    })
    invalidateStatus()
    return json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, data: { ...(r.data || {}), op: r.op } })
  }

  // ── 清空所有记忆（面板里藏在角落，确认两次才执行）
  if (req.method === 'POST' && route === '/memory/clear') {
    const dir = p('astrbot', 'data', 'plugin_data', 'astrbot_plugin_livingmemory')
    if (!existsSync(dir)) return json(res, 200, { ok: true, data: { deleted: [], note: '没有找到记忆目录' } })
    const r = await runOp('memory-clear', async () => {
      const gen = intentGen
      const wanted = desiredRunning !== false
      await stopService('astrbot')   // 等它真的退出，避免删到一半被占用
      const deleted = []
      try {
        const names = await readdir(dir)
        for (const name of names) {
          if (!/^(livingmemory|conversations|livingmemory_graph_documents)\.db(-wal|-shm)?$/.test(name)) continue
          await unlink(path.join(dir, name))
          deleted.push(name)
        }
      } catch (e) { throw new Error(`删除数据库失败：${e?.message || e}`) }
      const backups = path.join(dir, 'backups')
      try {
        for (const sub of await readdir(backups)) {
          for (const f of await readdir(path.join(backups, sub)).catch(() => [])) {
            await unlink(path.join(backups, sub, f)).catch(() => {})
          }
        }
      } catch { /* 没有备份目录 */ }
      if (wanted) await startService('astrbot', gen)
      return { deleted, restarted: wanted }
    })
    invalidateStatus()
    return json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, data: { ...(r.data || {}), op: r.op } })
  }

  // ── 记忆：选本地向量模型还是硅基流动
  const cmdCfgFile = () => p('astrbot', 'data', 'cmd_config.json')
  const lmCfgFile = () => p('astrbot', 'data', 'config', 'astrbot_plugin_livingmemory_config.json')

  async function readCmdCfg() {
    const raw = await readFile(cmdCfgFile(), 'utf8')
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  }

  async function ensureEmbedProviders(cmd, key) {
    const sources = Array.isArray(cmd.provider_sources) ? cmd.provider_sources : []
    const providers = Array.isArray(cmd.provider) ? cmd.provider : []

    const upsertSource = (entry) => {
      const i = sources.findIndex((s) => s.id === entry.id)
      if (i >= 0) sources[i] = { ...sources[i], ...entry }
      else sources.push(entry)
    }
    const upsertProvider = (entry) => {
      const i = providers.findIndex((x) => x.id === entry.id)
      if (i >= 0) providers[i] = { ...providers[i], ...entry }
      else providers.push(entry)
    }

    upsertSource({
      provider: 'local-embed', type: 'openai_embedding', provider_type: 'embedding',
      key: ['sk-local'], api_base: 'http://127.0.0.1:6198/v1',
      embedding_api_base: 'http://127.0.0.1:6198/v1', embedding_api_key: 'sk-local',
      timeout: 60, proxy: '', custom_headers: {}, id: 'local-embed', enable: true, embedding_dimensions: 512,
    })
    upsertProvider({ id: 'local-bge-m3', enable: true, provider_source_id: 'local-embed', model: 'bge-small-zh-v1.5', embedding_model: 'bge-small-zh-v1.5', embedding_dimensions: 512 })

    if (key) {
      upsertSource({
        provider: 'siliconflow-embed', type: 'openai_embedding', provider_type: 'embedding',
        key: [key], api_base: 'https://api.siliconflow.cn/v1',
        embedding_api_base: 'https://api.siliconflow.cn/v1', embedding_api_key: key,
        timeout: 30, proxy: '', custom_headers: {}, id: 'siliconflow-embed', enable: true, embedding_dimensions: 1024,
      })
      upsertProvider({ id: 'siliconflow-bge-m3', enable: true, provider_source_id: 'siliconflow-embed', model: 'BAAI/bge-m3', embedding_model: 'BAAI/bge-m3' })
    }
    cmd.provider_sources = sources
    cmd.provider = providers
  }

  if (req.method === 'GET' && route === '/memory') {
    let id = ''
    try {
      const lm = JSON.parse((await readFile(lmCfgFile(), 'utf8')).replace(/^\uFEFF/, ''))
      id = String(lm?.provider_settings?.embedding_provider_id || '')
    } catch { /* 没装 */ }
    let keyMasked = ''
    try {
      const cmd = await readCmdCfg()
      const src = (cmd.provider_sources || []).find((s) => s.id === 'siliconflow-embed')
      const k = src?.key?.[0] || ''
      keyMasked = k ? `${k.slice(0, 6)}…${k.slice(-4)}` : ''
    } catch { /* 忽略 */ }
    const mode = id.startsWith('siliconflow') ? 'siliconflow' : (id ? 'local' : 'none')
    return json(res, 200, { ok: true, data: { mode, providerId: id, keyMasked, embedUp: await portOpen(6198) } })
  }

  if (req.method === 'POST' && route === '/memory') {
    const body = await readBody(req)
    const mode = String(body.mode || 'local')
    const key = String(body.siliconflowKey || '').trim()
    if (mode === 'siliconflow' && !key) return json(res, 400, { ok: false, error: '选硅基流动要先填 key' })

    const r = await runOp('memory-switch', async () => {
      const cmd = await readCmdCfg()
      await ensureEmbedProviders(cmd, key || undefined)
      await writeFile(cmdCfgFile(), '\uFEFF' + JSON.stringify(cmd, null, 2), 'utf8')

      const lm = JSON.parse((await readFile(lmCfgFile(), 'utf8')).replace(/^\uFEFF/, ''))
      lm.provider_settings = lm.provider_settings || {}
      lm.provider_settings.embedding_provider_id = mode === 'siliconflow' ? 'siliconflow-bge-m3' : 'local-bge-m3'
      await writeFile(lmCfgFile(), JSON.stringify(lm, null, 2), 'utf8')

      const gen = intentGen
      if (mode === 'local') await startService('embed', gen)
      const wanted = desiredRunning !== false
      await stopService('astrbot')
      if (wanted) await startService('astrbot', gen)
      return { mode, restarted: wanted }
    })
    invalidateStatus()
    return json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, data: { ...(r.data || {}), op: r.op } })
  }

  // ── 能力开关：直接开关 AstrBot 里的函数工具（发说说、改签名、B站…）
  if (req.method === 'GET' && route === '/tools') {
    try {
      const j = await astrApi('GET', '/api/tools/list')
      const list = (j.data || [])
        .filter((t) => TOOL_LABELS[t.name])
        .map((t) => ({
          name: t.name,
          label: TOOL_LABELS[t.name][0],
          hint: TOOL_LABELS[t.name][1],
          active: !!t.active,
        }))
      return json(res, 200, { ok: true, data: { list } })
    } catch (e) {
      return json(res, 200, { ok: true, data: { list: [], error: String(e?.message || e) } })
    }
  }

  if (req.method === 'POST' && route === '/tools') {
    const body = await readBody(req)
    const name = String(body.name || '')
    if (!TOOL_LABELS[name]) return json(res, 400, { ok: false, error: '不认识这个工具' })
    try {
      await astrApi('POST', '/api/tools/toggle-tool', { name, activate: !!body.activate })
      return json(res, 200, { ok: true, data: { name, activate: !!body.activate } })
    } catch (e) {
      return json(res, e?.statusCode || 500, { ok: false, error: String(e?.message || e) })
    }
  }

  // ── 角色卡图片（内置卡在插件目录，自制卡在自己的目录）
  if (req.method === 'GET' && route.startsWith('/characters/img/')) {
    const name = decodeURIComponent(route.slice('/characters/img/'.length)).replace(/[\\/]/g, '')
    const candidates = [path.join(presetCharDir, 'img', name), path.join(userCharDir, 'img', name)]
    for (const f of candidates) {
      if (!existsSync(f)) continue
      try {
        const buf = await readFile(f)
        const ext = path.extname(f).toLowerCase()
        const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' })
        res.end(buf)
      } catch { json(res, 500, { ok: false, error: '读不到图片' }) }
      return
    }
    return json(res, 404, { ok: false, error: '没有这张图' })
  }

  // ── 角色卡
  if (req.method === 'GET' && route === '/characters') {
    return json(res, 200, { ok: true, data: { list: await listCharacters() } })
  }

  if (req.method === 'POST' && route === '/characters/apply') {
    const body = await readBody(req)
    const card = await findCharacter(String(body.id || ''))
    if (!card) return json(res, 404, { ok: false, error: '找不到这张角色卡' })
    const st = await readJson(stateFile, {})
    const owner = String(st.ownerQQ || '')
    const text = String(card.persona || '').replaceAll('{OWNER_QQ}', owner)
    if (!text.trim()) return json(res, 400, { ok: false, error: '这张卡没有正文' })
    await mkdir(path.dirname(personaFile()), { recursive: true })
    await writeFile(personaFile(), text, 'utf8')
      invalidateStatus()
    let pushed = false
    let warning = ''
    try { pushed = await pushPersona(text) } catch (e) { warning = String(e?.message || e) }
    return json(res, 200, { ok: true, data: { pushed, warning } })
  }

  // 可选配图：内置立绘 + 抽象图案
  if (req.method === 'GET' && route === '/characters/art') {
    const list = []
    for (const [dir, tag] of [[path.join(presetCharDir, 'img'), 'builtin'], [path.join(userCharDir, 'img'), 'user']]) {
      try {
        for (const n of await readdir(dir)) {
          if (!/\.(webp|png|jpe?g)$/i.test(n)) continue
          if (n.startsWith('abstract-')) list.push({ file: n, kind: 'abstract' })
          else if (tag === 'user') list.push({ file: n, kind: 'user' })
        }
      } catch { /* 没有目录 */ }
    }
    // 角色卡自己的立绘也列出来，方便复用
    for (const n of await readdir(path.join(presetCharDir, 'img')).catch(() => [])) {
      if (/\.(webp|png|jpe?g)$/i.test(n) && !n.startsWith('abstract-')) list.push({ file: n, kind: 'character' })
    }
    return json(res, 200, { ok: true, data: { list } })
  }

  // 删除自制卡（内置卡不允许删）
  if (req.method === 'POST' && route === '/characters/delete') {
    const body = await readBody(req)
    const id = String(body.id || '')
    // 只接受合法 id，不做“替换字符”式修正：宁可拒绝，也不让 ../ 有机会
    if (!validCharacterId(id)) {
      return json(res, 400, { ok: false, error: '非法 id' })
    }
    if (existsSync(path.join(presetCharDir, `${id}.json`))) {
      return json(res, 403, { ok: false, error: '内置卡不能删除' })
    }
    const file = path.resolve(userCharDir, `${id}.json`)
    if (path.dirname(file) !== path.resolve(userCharDir)) {
      return json(res, 400, { ok: false, error: '非法路径' })
    }
    if (!existsSync(file)) return json(res, 404, { ok: false, error: '这张卡不存在' })
    const removedCard = await readJson(file, null)
    await unlink(file)
    // 仅清理此卡拥有、且未被其他卡复用的图片；不删除内置或共享素材。
    const ownedAvatar = String(removedCard?.avatar || '')
    const ownsName = new RegExp(`^${id}(?:-[0-9a-f-]{36})?\\.(png|jpe?g|webp)$`, 'i').test(ownedAvatar)
    if (ownsName && path.basename(ownedAvatar) === ownedAvatar) {
      const shared = (await listCharacters()).some(card => card.avatar === ownedAvatar)
      if (!shared) await unlink(path.join(userCharDir, 'img', ownedAvatar)).catch(() => {})
    }
    return json(res, 200, { ok: true, data: { id } })
  }

  if (req.method === 'POST' && route === '/characters') {
    const body = await readBody(req)
    const id = String(body.id || body.name || '').trim().toLowerCase().replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    if (!validCharacterId(id)) return json(res, 400, { ok: false, error: '角色 id 无效、过长或是 Windows 保留名' })
    const cardFile = path.join(userCharDir, `${id}.json`)
    if (existsSync(cardFile) || existsSync(path.join(presetCharDir, `${id}.json`))) {
      return json(res, 409, { ok: false, error: '角色 id 已存在，请换一个名字' })
    }
    await mkdir(userCharDir, { recursive: true })

    let avatar = String(body.avatar || '').trim()
    if (avatar && (path.basename(avatar) !== avatar || !/^[^\\/]+\.(png|jpe?g|webp)$/i.test(avatar) ||
        ![path.join(presetCharDir, 'img', avatar), path.join(userCharDir, 'img', avatar)].some(existsSync))) {
      return json(res, 400, { ok: false, error: '配图必须是已有图片文件名' })
    }
    let uploadedFile = ''
    if (body.avatarDataUrl) {
      const image = checkedAvatar(body.avatarDataUrl)
      const imgDir = path.join(userCharDir, 'img')
      await mkdir(imgDir, { recursive: true })
      avatar = `${id}-${randomUUID()}.${image.ext}`
      uploadedFile = path.join(imgDir, avatar)
      await writeFile(uploadedFile, image.bytes, { flag: 'wx' })
    }

    const card = {
      id,
      name: String(body.name || id),
      title: String(body.title || ''),
      tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      intro: String(body.intro || ''),
      persona: String(body.persona || ''),
      avatar,
      builtin: false,
    }
    try {
      await writeFile(cardFile, JSON.stringify(card, null, 2), { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if (uploadedFile) await unlink(uploadedFile).catch(() => {})
      if (error.code === 'EEXIST') return json(res, 409, { ok: false, error: '角色 id 已存在' })
      throw error
    }
    return json(res, 200, { ok: true, data: { id } })
  }

  // ── 一键应用：把 key 交给配置包的导入工具（它负责装插件、写配置、开记忆/语音）
    if (req.method === 'POST' && route === '/apply') {
      const body = await readBody(req)
      if (applyPending || importJob.running) return json(res, 409, { ok: false, error: '已有导入任务正在运行' })
      if (!(await getDesired())) return json(res, 409, { ok: false, error: '当前已停止，请先启动再应用' })
      const st = await readJson(stateFile, {})
      const owner = String(body.ownerQQ || st.ownerQQ || '').trim()
      if (!/^\d{5,20}$/.test(owner)) return json(res, 400, { ok: false, error: '主人 QQ 应为 5 至 20 位数字' })

      const answers = {
        base_url: `http://127.0.0.1:${astrPort}`,
        username: astrUser,
        password: astrPass,
        owner_qq: owner,
        memory: body.siliconflowKey ? '2' : 'keep',
        voice: body.volcId && body.volcToken ? '3' : '1',
      }
      if (body.siliconflowKey) answers.siliconflow_key = String(body.siliconflowKey)
      if (body.volcId && body.volcToken) {
        answers.volc_app_id = String(body.volcId)
        answers.volc_access_token = String(body.volcToken)
      }

      const py = p('astrbot', 'venv', 'Scripts', 'python.exe')
      const importer = p('config-pack', 'tools', 'import_dafeiyu.py')
      if (!existsSync(py) || !existsSync(importer)) {
        return json(res, 400, { ok: false, error: '找不到导入工具，检查 bundlePath' })
      }
      // 不绕过启停意图：用户已停止时拒绝，避免“应用”把服务偷偷拉起来
      await getDesired()
      if (desiredRunning === false) {
        return json(res, 409, { ok: false, error: '当前是「已停止」状态，先启动机器人再应用' })
      }

      if (applyPending || importJob.running) return json(res, 409, { ok: false, error: '已有导入任务正在运行' })
      const credentials = [answers.password, answers.siliconflow_key, answers.volc_access_token].filter(Boolean)
      if (credentials.some(value => /[\r\n]/.test(value) || value.length > 4096)) return json(res, 400, { ok: false, error: '凭证长度或格式无效' })
      applyPending = true
      let r
      try { r = await runOp('apply', async () => {
        const gen = intentGen
        // 只确保 AstrBot 在跑，不改意图；锁内核对一次，防止刚被停止
        ensureRunning(gen, '应用配置')
        await startService('astrbot', gen)

        ensureRunning(gen, '应用配置')
        const job = importJob.start({ python: py, importer, cwd: p('config-pack'), answers, env: process.env })
        // Keep subsequent maintenance operations queued until this child really exits.
        void withLock(() => job.done)
        if (!(await job.ready)) throw new Error(importJob.status().error || '无法启动导入进程')
        return { started: true, jobId: job.id, log: '仅保留本次内存日志' }
      }) } finally { applyPending = false }
      return json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error, data: { ...(r.data || {}), op: r.op } })
    }

    if (req.method === 'GET' && route === '/apply/status') {
      return json(res, 200, { ok: true, data: importJob.status() })
    }

    return json(res, 404, { ok: false, error: 'no such route' })
  }

  /**
   * 看门狗：每个服务独立判断、独立退避；一个起不来不影响其他。
   * 只在“用户希望它跑”（desiredRunning）时动手；停止意图下绝不拉起。
   */
  ctx.effect(() => {
    const timer = setInterval(async () => {
      if (!watchdog.enabled) return
      if (!existsSync(bundle)) return
      const wanted = await getDesired().catch(() => false)
      if (!wanted) return
      if (await isOpRunning()) return   // 有维护操作在跑，别插队

      // 与手动操作共用一把锁：维护期间看门狗排队而不是插队
      await withLock(async () => {
        const again = await getDesired().catch(() => false)
        if (!again) return
        const gen = intentGen
        for (const name of ['astrbot', 'embed', 'napcat']) {
          const s = services[name]
          const now = Date.now()
          if (now < (watchdog.nextTry[name] || 0)) continue
          try {
            if (await s.ready()) continue
            // 进程还在（加载中/degraded）就不重复拉起，交给人工或等它自己好
            const pids = await servicePids(name)
            if (pids.length) {
              watchdog.nextTry[name] = now + 60_000
              continue
            }
            // 端口被别的程序占着：报 occupied，不启动
            if (await portOpen(svcPort(s))) {
              watchdog.lastAction = `${name} 端口被其它进程占用（occupied），未自动启动`
              watchdog.nextTry[name] = now + 300_000
              continue
            }
            // NapCat：QQ 已在线（探针新鲜）时不重启，避免触发风控
            if (name === 'napcat') {
              const st = await readJson(path.join(HOME, '.dsh', 'dafeiyu-qq-state.json'), {})
              const fresh = st && Date.now() - Number(st.at || 0) < 90_000
              if (fresh && st.online) { watchdog.nextTry[name] = now + 120_000; continue }
            }
            await startService(name, gen)
            watchdog.lastAt = Date.now()
            watchdog.lastAction = `${name} 掉线，已自动拉起（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`
            watchdog.nextTry[name] = 0
          } catch {
            // 退避：失败后 5 分钟再试这个服务，不影响其它服务
            watchdog.nextTry[name] = Date.now() + 300_000
          }
        }
      }).catch(() => {})
    }, 30_000)
    return () => clearInterval(timer)
  }, 'dafeiyu-console: watchdog')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/dafeiyu',
    handler: async (req, res) => {
      if (!guard(req, res, json)) return
      try {
        await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
      } catch (e) {
        json(res, e?.statusCode || 500, { ok: false, error: String(e?.message || e) })
      }
    },
  }), 'dafeiyu-console: /api/dafeiyu')
}
