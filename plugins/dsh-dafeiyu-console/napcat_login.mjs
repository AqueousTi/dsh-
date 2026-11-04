import { readFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createHash } from 'node:crypto'

const ROUTES = new Set(['/auth/login', '/QQLogin/CheckLoginStatus', '/QQLogin/GetQQLoginInfo',
  '/QQLogin/GetQQLoginQrcode', '/QQLogin/RefreshQRcode'])
const QR_PYTHON = 'import sys, qrcode; qrcode.make(sys.stdin.read()).save(sys.stdout.buffer, format="PNG")'

export function renderQr(python, value, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    let child, timer, finished = false, size = 0
    const chunks = []
    const finish = (error, result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (error) { child?.kill(); reject(error) } else resolve(result)
    }
    try {
      child = spawnImpl(python, ['-X', 'utf8', '-c', QR_PYTHON], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      })
      timer = setTimeout(() => finish(new Error('二维码绘制超时')), 8000)
      child.on('error', () => finish(new Error('无法启动二维码绘制，请检查随包 Python')))
      child.stdin.on('error', () => finish(new Error('二维码绘制输入失败')))
      child.stdout.on('data', chunk => {
        size += chunk.length
        if (size > 1_000_000) return finish(new Error('二维码图片过大'))
        chunks.push(chunk)
      })
      child.on('close', code => {
        const png = Buffer.concat(chunks)
        if (code !== 0 || png.length < 8 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
          return finish(new Error('二维码绘制失败，请检查随包 qrcode 依赖'))
        }
        finish(null, png)
      })
      // Login URLs are credentials: stdin only, never command arguments or files.
      child.stdin.end(value)
    } catch { finish(new Error('二维码绘制无法启动')) }
  })
}

export function createNapcatLogin({ bundle, fetchImpl = fetch, readFileImpl = readFile,
  readdirImpl = readdir, renderImpl = renderQr, now = Date.now }) {
  let credential = '', credentialUntil = 0, credentialKey = '', authPending = null
  let stateCache = null, stateUntil = 0, statePending = null
  let qrValue = '', qrSeen = 0, pngValue = '', pngCache = null
  const python = path.join(bundle, 'astrbot', 'venv', 'Scripts', 'python.exe')

  async function post(route, body = {}, auth = '') {
    if (!ROUTES.has(route)) throw new Error('不支持的 NapCat 登录接口')
    let response, payload
    try {
      response = await fetchImpl('http://127.0.0.1:6099/api' + route, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + auth } : {}) },
        body: JSON.stringify(body),
      })
      payload = await response.json()
    } catch { throw new Error('NapCat 后台查询失败或超时，请确认 NapCat 正在运行') }
    if (!response.ok || payload?.code !== 0) {
      const error = new Error('NapCat 后台未接受登录查询，请检查本机后台配置')
      error.unauthorized = response.status === 401 || response.status === 403 ||
        ['Unauthorized', 'Authorization Failed'].includes(payload?.message)
      throw error
    }
    return payload.data
  }

  async function authenticate() {
    if (authPending) return authPending
    authPending = (async () => {
      const versions = path.join(bundle, 'napcat', 'NapCat.52230.Shell', 'versions')
      let configs = []
      try {
        for (const version of await readdirImpl(versions)) {
          try {
            const file = path.join(versions, version, 'resources', 'app', 'napcat', 'config', 'webui.json')
            const cfg = JSON.parse(String(await readFileImpl(file, 'utf8')).replace(/^\uFEFF/, ''))
            if (Number(cfg.port) === 6099 && typeof cfg.token === 'string' && cfg.token) configs.push(cfg)
          } catch { /* nonmatching version */ }
        }
      } catch { /* reported below */ }
      if (configs.length !== 1) throw new Error('找不到唯一的本机 NapCat 后台配置')
      const cfg = configs[0]
      if (cfg.enable2FA) throw new Error('NapCat 后台启用了二次验证，请先在原生后台验证')
      const key = createHash('sha256').update(cfg.token + '.napcat').digest('hex')
      if (credential && key === credentialKey && now() < credentialUntil) return credential
      const result = await post('/auth/login', { hash: key })
      if (!result?.Credential || typeof result.Credential !== 'string') throw new Error('NapCat 后台认证未完成')
      credential = result.Credential
      credentialKey = key
      credentialUntil = now() + 45 * 60_000
      return credential
    })()
    try { return await authPending } finally { authPending = null }
  }

  async function api(route, body = {}) {
    const auth = await authenticate()
    try { return await post(route, body, auth) }
    catch (error) {
      if (!error.unauthorized) throw error
      credential = ''; credentialUntil = 0
      return post(route, body, await authenticate())
    }
  }

  async function state(force = false) {
    if (!force && stateCache && now() < stateUntil) return stateCache
    if (statePending) return statePending
    statePending = (async () => {
      const data = await api('/QQLogin/CheckLoginStatus')
      if (!data || typeof data.isLogin !== 'boolean') throw new Error('NapCat 登录状态响应无效')
      const result = { loginKnown: true, loggedIn: data.isLogin,
        loginPending: data.qrLoginAccepted === true || data.loginPhase === 'initializing',
        coreReady: data.coreReady === true, offline: data.isOffline === true,
        phase: typeof data.loginPhase === 'string' ? data.loginPhase : '' }
      if (!result.loggedIn && /近期存在安全风险|部分功能使用受限|账号.{0,12}(?:安全风险|使用受限|限制登录)/.test(String(data.loginError || ''))) {
        result.loginIssue = 'account_restricted'
        result.loginMessage = 'QQ 提示账号存在安全限制，请先在官方手机 QQ 按提示恢复账号，再获取新码。'
      }
      if (result.loggedIn) {
        try {
          const info = await api('/QQLogin/GetQQLoginInfo')
          result.uin = String(info?.uin || '')
          result.nickname = String(info?.nick || info?.nickname || '')
        } catch { /* identity is optional */ }
      }
      stateCache = result; stateUntil = now() + 1500
      return result
    })()
    try { return await statePending } finally { statePending = null }
  }

  async function currentQr() {
    const status = await state()
    if (status.loggedIn || status.loginPending || status.loginIssue) return { ...status, hasQr: false, mtime: 0 }
    const data = await api('/QQLogin/GetQQLoginQrcode')
    const value = data?.qrcode
    if (typeof value !== 'string' || !value || value.length > 8192) throw new Error('NapCat 尚未提供当前登录二维码')
    if (value !== qrValue) { qrValue = value; qrSeen = now() }
    // Never return the QR login URL to the status API or logs.
    return { ...status, hasQr: true, mtime: qrSeen }
  }

  return {
    state,
    qr: currentQr,
    async png() {
      const status = await currentQr()
      if (!status.hasQr) throw new Error('当前无需扫描二维码，请查看登录状态')
      const value = qrValue
      if (pngValue !== value || !pngCache) {
        const png = await renderImpl(python, value)
        pngValue = value; pngCache = png
      }
      return pngCache
    },
    async refresh({ afterRecovery = false } = {}) {
      const status = await state(true)
      if (status.loggedIn) return { alreadyLoggedIn: true }
      if (status.loginPending) throw new Error('手机确认已接受，正在初始化，请稍候再刷新状态')
      if (status.loginIssue && !afterRecovery) throw new Error(status.loginMessage)
      await api('/QQLogin/RefreshQRcode')
      stateCache = null; stateUntil = 0; qrValue = ''; qrSeen = 0; pngCache = null
      return { refreshed: true }
    },
  }
}
