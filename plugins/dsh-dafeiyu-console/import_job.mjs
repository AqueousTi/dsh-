import { StringDecoder } from 'node:string_decoder'
import { createHash } from 'node:crypto'

// No filesystem, process or timer activity until start() is called.
export function createImportJob({ spawnImpl, setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 20 * 60_000 }) {
  let current = null
  let sequence = 0
  const status = () => current ? {
    id: current.id, running: !current.finished, ok: current.ok, exitCode: current.exitCode,
    error: current.error, tail: current.tail, startedAt: current.startedAt,
  } : { id: 0, running: false, ok: null, exitCode: null, error: '', tail: '', startedAt: 0 }

  function cancel(reason = '导入已取消') {
    if (!current || current.finished) return
    current.error = reason
    try { current.child?.kill() } catch { /* Keep running status until exit is confirmed. */ }
  }

  function start({ python, importer, cwd, answers, env = {} }) {
    if (current && !current.finished) throw new Error('已有导入任务正在运行')
    const secrets = Object.entries(answers)
      .filter(([key]) => /password|token|secret|key/i.test(key))
      .map(([, value]) => String(value || '')).filter(Boolean)
    if (secrets.some(value => /[\r\n]/.test(value) || value.length > 4096)) throw new Error('凭证长度或格式无效')
    const forms = new Set(secrets.flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))
    if (answers.password) forms.add(createHash('md5').update(String(answers.password)).digest('hex'))
    const needles = [...forms].sort((a, b) => b.length - a.length)
    const redact = value => {
      let text = String(value)
      for (const secret of needles) text = text.split(secret).join('[已隐藏]')
      return text.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    }
    let complete, spawned
    const done = new Promise(resolve => { complete = resolve })
    const ready = new Promise(resolve => { spawned = resolve })
    const job = current = { id: ++sequence, child: null, tail: '', error: '', ok: null,
      exitCode: null, startedAt: Date.now(), finished: false, timer: null }
    const append = text => { job.tail = (job.tail + redact(text)).slice(-64_000) }
    const streams = []
    function finish(code) {
      if (job.finished) return
      for (const stream of streams) stream.flush()
      job.finished = true
      if (job.timer !== null) clearTimer(job.timer)
      job.exitCode = Number.isInteger(code) ? code : null
      job.ok = code === 0 && !job.error
      if (!job.ok && !job.error) job.error = '导入未成功，请查看日志'
      append(`\n${job.ok ? '导入完成' : job.error}\n`)
      spawned(job.ok)
      complete({ ok: job.ok, exitCode: job.exitCode, error: job.error })
    }
    function capture(source) {
      const decoder = new StringDecoder('utf8')
      let pending = '', dropping = false
      const consume = text => {
        for (const piece of text.split(/(?<=\n)/)) {
          if (!dropping) pending += piece
          if (pending.length > 16_384) { pending = ''; dropping = true }
          if (piece.endsWith('\n')) {
            append(dropping ? '[过长日志行已省略]\n' : pending)
            pending = ''; dropping = false
          }
        }
      }
      source?.on('data', chunk => consume(decoder.write(Buffer.from(chunk))))
      streams.push({ flush() {
        consume(decoder.end())
        if (pending || dropping) append(dropping ? '[过长日志行已省略]\n' : pending)
        pending = ''; dropping = false
      } })
    }
    try {
      // Inherit ordinary process settings, never propagate installer credential variables.
      const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^DAFY_.*(?:KEY|TOKEN|PASSWORD)$/i.test(key)))
      const child = job.child = spawnImpl(python, ['-X', 'utf8', importer, '--answers', '-'], {
        cwd, env: { ...childEnv, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        shell: false, detached: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
      capture(child.stdout); capture(child.stderr)
      child.once('spawn', () => spawned(true))
      child.once('error', () => { job.error = '无法启动导入进程'; finish(null) })
      child.once('close', code => finish(code))
      child.stdin.on('error', () => {
        if (!job.finished) cancel('无法传递导入参数')
      })
      job.timer = setTimer(() => cancel('导入超时，已请求停止'), timeoutMs)
      job.timer?.unref?.()
      child.stdin.end(JSON.stringify(answers), 'utf8')
    } catch {
      job.error = '无法启动或传递导入参数'
      try { job.child?.kill() } catch { /* Child may not have been created. */ }
      finish(null)
    }
    return { ready, done, id: job.id }
  }
  return { start, cancel, status, get running() { return Boolean(current && !current.finished) } }
}
