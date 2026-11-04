/**
 * dsh-restart-app —— host 半边
 *
 * 只做一件事：POST /api/restart/dsh
 *   1. 写一个临时 .cmd：等几秒 → 杀掉 DeepSeek Harness.exe → 再启动它
 *   2. 用 start 把它甩到独立进程里跑，这样 DSH 被杀掉时它不会跟着死
 *
 * 为什么不用 process.exit：整个应用需要重新走一遍启动流程（插件、profile、客户端包），
 * 只重启进程里的某个服务不算“重启 DSH”。
 */

import { spawn, execFile } from 'node:child_process'
import { writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'

const execFileP = promisify(execFile)
const TASK_NAME = 'DSHRestart'

export const name = 'dsh-restart-app'
export const inject = ['webServer']

const HOME = os.homedir()

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function apply(ctx, config) {
  const cfgExe = String(config?.exePath || '').trim()
  // 依次尝试：配置值 → 当前可执行文件（必须就是 DSH）→ 同目录的 DSH → 默认安装位置
  const candidates = [
    cfgExe,
    /DeepSeek Harness\.exe$/i.test(process.execPath || '') ? process.execPath : '',
    process.execPath ? path.join(path.dirname(process.execPath), 'DeepSeek Harness.exe') : '',
    'D:\\dsh\\DeepSeek Harness.exe',
  ].filter(Boolean)
  const exe = candidates.find((p) => existsSync(p)) || cfgExe || process.execPath
  const delay = Math.max(1, Math.min(60, Number(config?.delaySeconds || 3)))
  const scriptFile = path.join(HOME, '.dsh', 'dsh-restart.vbs')
  const logFile = path.join(HOME, '.dsh', 'dsh-restart.log')
  let inFlight = false

  /** 往原生菜单「应用」里插一项，紧挨着「退出」 */
  function attachAppMenu() {
    try {
      const req = createRequire(import.meta.url)
      const electron = req('electron')
      const Menu = electron?.Menu
      const MenuItem = electron?.MenuItem
      if (!Menu || typeof Menu.getApplicationMenu !== 'function') return { ok: false, why: '拿不到 Electron Menu' }
      const menu = Menu.getApplicationMenu()
      if (!menu) return { ok: false, why: '应用菜单还没建好' }
      if (menu.items.some((it) => (it.label || '').includes('重启 DSH'))) return { ok: true, why: 'already' }
      let idx = menu.items.findIndex((it) => it.role === 'quit' || /退出/.test(it.label || ''))
      if (idx < 0) idx = menu.items.length
      const item = new MenuItem({
        label: '重启 DSH',
        click: () => { restart().catch((e) => console.error('[dsh-restart]', e)) },
      })
      menu.insert(idx, item)
      return { ok: true, why: 'inserted', idx }
    } catch (e) {
      return { ok: false, why: String(e?.message || e) }
    }
  }

  const menuStatus = attachAppMenu()
  if (!menuStatus.ok) console.warn('[dsh-restart] 菜单项没插上：', menuStatus.why)

  async function restart() {
    if (!exe || !existsSync(exe)) throw new Error(`找不到可执行文件：${exe || '(空)'}`)
    // 用 VBScript 而不是 .cmd：wscript 没有控制台，Run(..., 0, ...) 全程不弹黑窗口。
    // 注意：VBS 里只写 ASCII —— wscript 按 ANSI 读脚本，中文容易变成解析错误。
    const vbs = [
      'Set sh = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `fso.OpenTextFile("${logFile}", 8, True).WriteLine "[" & Now & "] restart requested"`,
      `WScript.Sleep ${Math.max(0, Math.round(delay * 1000))}`,
      'sh.Run "taskkill /IM ""DeepSeek Harness.exe"" /F", 0, True',
      // taskkill 带 True 会等进程真的退出，再给 500ms 让系统收尾
      'WScript.Sleep 500',
      `sh.Run Chr(34) & "${exe}" & Chr(34), 1, False`,
      `fso.OpenTextFile("${logFile}", 8, True).WriteLine "[" & Now & "] launch issued"`,
      `sh.Run "schtasks /delete /tn ""${TASK_NAME}"" /f", 0, False`,
      '',
    ].join('\r\n')
    await mkdir(path.dirname(scriptFile), { recursive: true })
    await writeFile(scriptFile, vbs, 'utf8')

    // 关键：不能用 start/cmd 直接从插件里派生 —— 那会落在 DSH 的作业对象里，
    // 应用被 taskkill 掉时脚本会跟着被杀，永远走不到“重新启动”那一步。
    // 交给计划任务：它由 Task Scheduler 服务拉起，不在我们的进程树里。
    // 再用 wscript //B 跑 VBS：没有控制台，不会弹黑窗口。
    // windowsHide 必须给：从无控制台的 Electron 里起 schtasks，默认会闪一个黑窗口
    const opts = { windowsHide: true }
    // 上一轮如果卡在 Running，/create 会失败 —— 先清掉旧的
    await execFileP('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], opts).catch(() => {})
    await execFileP('schtasks', ['/create', '/tn', TASK_NAME, '/tr', `wscript.exe //B "${scriptFile}"`, '/sc', 'once', '/st', '00:00', '/f'], opts)
    // 基线要在 /run 之前采样：VBS 可能在 /run 返回前就写了日志
    const before = existsSync(logFile) ? (await stat(logFile)).mtimeMs : 0
    await execFileP('schtasks', ['/run', '/tn', TASK_NAME], opts)
    let started = false
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const now = existsSync(logFile) ? (await stat(logFile)).mtimeMs : 0
      if (now > before) { started = true; break }
    }
    if (!started) throw new Error('计划任务没有跑起来（日志没有更新），可以手动重启')
    return { exe, delay, mode: 'schtasks+wscript' }
  }

  // 可信 authority：延迟解析宿主 origin/port，解析不到时只允许回环主机名
  let trustedCache = null
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
    const proto = raw.startsWith('https:') ? 'https:' : 'http:'
    const add = (host) => {
      auths.add(`${host}:${port}`.toLowerCase())
      origins.add(`${proto}//${host}:${port}`.toLowerCase())
    }
    add('127.0.0.1')
    add('localhost')
    if (raw) { try { add(new URL(raw).hostname) } catch { /* 忽略 */ } }
    trustedCache = { auths, origins, port }
    return trustedCache
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/restart',
    handler: async (req, res) => {
      const addr = req.socket?.remoteAddress || ''
      if (!(addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1')) {
        return json(res, 403, { ok: false, error: '只接受本机请求' })
      }
      const host = String(req.headers?.host || '').toLowerCase()
      const trusted = resolveTrusted()
      if (!trusted) return json(res, 503, { ok: false, error: '宿主端口尚未就绪' })
      if (!trusted.auths.has(host)) return json(res, 403, { ok: false, error: '请求 Host 不受信任' })
      const origin = req.headers?.origin
      if (origin) {
        let u
        try { u = new URL(String(origin)) } catch {
          return json(res, 403, { ok: false, error: '跨站请求被拒绝' })
        }
        if (!trusted.origins.has(u.origin.toLowerCase())) {
          return json(res, 403, { ok: false, error: '跨站请求被拒绝' })
        }
      }
      if (req.method !== 'GET' && String(req.headers?.['x-dfy-console'] || '') !== '1') {
        return json(res, 403, { ok: false, error: '缺少请求头 x-dfy-console' })
      }
      const ctype = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (req.method !== 'GET' && ctype && ctype !== 'application/json') {
        return json(res, 415, { ok: false, error: '只接受 application/json' })
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/api/restart/info' && req.method === 'GET') {
        return json(res, 200, { ok: true, data: { exe, delay, exists: existsSync(exe), menu: menuStatus, busy: inFlight } })
      }
      if (url.pathname === '/api/restart/dsh' && req.method === 'POST') {
        if (inFlight) return json(res, 409, { ok: false, error: '上一次重启还在处理中' })
        inFlight = true
        try {
          const info = await restart()
          return json(res, 200, { ok: true, data: info })
        } catch (e) {
          inFlight = false
          return json(res, 500, { ok: false, error: String(e?.message || e) })
        }
      }
      return json(res, 404, { ok: false, error: 'no such route' })
    },
  }), 'dsh-restart: /api/restart')
}
