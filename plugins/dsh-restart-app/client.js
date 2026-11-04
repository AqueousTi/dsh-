/**
 * dsh-restart-app —— 浏览器半边
 *
 * 侧栏底部一个「重启」按钮，点了弹确认，确认后调 host 重启整个 DSH。
 */

window.__ModuleLoader__.load({
  id: 'dsh-restart-app',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const API = '/api/restart'

    let openState = false
    const listeners = new Set()
    function setOpen(v) {
      openState = v
      for (const fn of listeners) fn(v)
    }
    function useOpen() {
      const [v, setV] = useState(openState)
      useEffect(() => {
        listeners.add(setV)
        return () => { listeners.delete(setV) }
      }, [])
      return v
    }

    const S = {
      btn: {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px',
        borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer',
        color: 'inherit', fontSize: 13, textAlign: 'left',
      },
      root: {
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
        alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.38)',
        pointerEvents: 'auto',
      },
      card: {
        width: 380, maxWidth: '90vw', borderRadius: 14, padding: '20px 22px',
        boxShadow: '0 18px 48px rgba(0,0,0,.35)',
        background: '#fff', color: '#1b1b1f', border: '1px solid #e4e6ea', fontSize: 13,
      },
      title: { fontSize: 15, fontWeight: 600, marginBottom: 8 },
      text: { fontSize: 12.5, lineHeight: 1.7, color: '#5b5f66' },
      row: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
      primary: { padding: '7px 16px', borderRadius: 7, border: '1px solid #d64545', background: '#d64545', color: '#fff', cursor: 'pointer', fontSize: 13 },
      ghost: { padding: '7px 16px', borderRadius: 7, border: '1px solid #dcdcdc', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13 },
      hint: { fontSize: 12, color: '#1a7f37', marginTop: 10 },
      err: { fontSize: 12, color: '#d1242f', marginTop: 10 },
    }

    function Button() {
      return h('button', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px',
          borderRadius: 7, border: '1px solid var(--dsw-alias-border-subtle, #dcdcdc)',
          background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12,
          whiteSpace: 'nowrap',
        },
        title: '重启 DeepSeek Harness',
        onClick: () => setOpen(true),
      },
        h('span', { style: { fontSize: 13, lineHeight: 1 } }, '⟳'),
        h('span', null, '重启'),
      )
    }

    function Confirm() {
      const open = useOpen()
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      if (!open) return null

      const go = async () => {
        setBusy(true); setMsg(null)
        try {
          const r = await fetch(API + '/dsh', { method: 'POST', credentials: 'same-origin', headers: { 'x-dfy-console': '1' } })
          const j = await r.json().catch(() => ({}))
          if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`)
          setMsg({ ok: true, text: '已安排重启，几秒后窗口会自己关掉再打开' })
        } catch (e) {
          setMsg({ ok: false, text: String(e.message || e) })
          setBusy(false)
        }
      }

      return h('div', {
        style: S.root,
        onMouseDown: (e) => { if (e.target === e.currentTarget && !busy) setOpen(false) },
      },
        h('div', { style: S.card },
          h('div', { style: S.title }, '重启 DeepSeek Harness？'),
          h('div', { style: S.text },
            '整个应用会关掉，大约几秒后自动重新打开。',
            h('br'),
            '正在跑的对话会中断，插件和 profile 会重新加载。'),
          msg && h('div', { style: msg.ok ? S.hint : S.err }, msg.text),
          h('div', { style: S.row },
            h('button', { style: S.ghost, disabled: busy, onClick: () => setOpen(false) }, '取消'),
            h('button', { style: S.primary, disabled: busy, onClick: go }, busy ? '重启中…' : '确认重启')),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        try {
          slots.inject('conversation.session.header.utilities', () => slots.register(
            { name: 'conversation.session.header.utilities', id: 'dsh-restart', order: 50 },
            Button,
          ))
        } catch { /* 这个槽位没有就算了 */ }
        try {
          slots.inject('shell.overlay', () => slots.register(
            { name: 'shell.overlay', id: 'dsh-restart-confirm', order: 110 },
            Confirm,
          ))
        } catch { /* 同上 */ }
      },
    }
  },
})
