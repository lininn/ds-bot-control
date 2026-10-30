import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

// Settings → Remote control. Signing in here binds this computer to a blog account and
// starts the outbound connector, so a phone signing in to the same account can drive it.
// The token stays on the host; this page only ever sees whether it is bound.
export function RelayPage({ actions, Section, Row }) {
  const [status, setStatus] = useState(null)
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const alive = useRef(true)

  const refresh = useCallback(() => {
    actionsRef.current.relayStatus()
      .then((next) => {
        if (!alive.current) return
        setStatus(next)
        setUrl(current => (current === '' && next.url ? next.url : current))
      })
      .catch(failure => { if (alive.current) setError(failure?.message ?? String(failure)) })
  }, [])

  useEffect(() => {
    alive.current = true
    refresh()
    const timer = setInterval(refresh, 2500)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh])

  const login = () => {
    if (busy || username.trim() === '' || password === '') return
    setBusy(true)
    setError('')
    actions.relayLogin({ username: username.trim(), password, url: url.trim() })
      .then((next) => { setStatus(next); setPassword('') })
      .catch(failure => setError(failure?.message ?? String(failure)))
      .finally(() => setBusy(false))
  }

  const logout = () => {
    if (busy) return
    setBusy(true)
    setError('')
    actions.relayLogout()
      .then(next => setStatus(next))
      .catch(failure => setError(failure?.message ?? String(failure)))
      .finally(() => setBusy(false))
  }

  if (status === null) {
    return h(Section, { title: t('Remote control') }, h('p', { className: 'bt-set-hint' }, t('Checking…')))
  }

  if (status.bound) {
    const online = status.relayConnected
    return h(Section, { title: t('Remote control') },
      h(Row, {
        label: t('Signed in as {name}', { name: status.username || t('this computer') }),
        hint: t('Open the relay on your phone and sign in with the same account.'),
      }, h('span', { className: 'bt-set-hint', role: 'status' }, online ? t('Connected') : t('Reconnecting…'))),
      h(Row, { label: t('This computer'), hint: status.deviceName }, null),
      h('div', { className: 'bt-set-row' },
        h('div', { className: 'bt-set-copy' }, h('span', null, t('Turn off remote control'))),
        h('div', { className: 'bt-set-control' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: logout }, t('Sign out')))),
      error ? h('div', { className: 'bt-connector-error', role: 'alert', style: { padding: '8px 12px' } }, error) : null)
  }

  return h(Section, { title: t('Remote control') },
    h('p', { className: 'bt-set-hint' }, t('Sign in with your account to let your phone control this computer. The phone signs in with the same account.')),
    h(Row, { label: t('Relay address'), hint: t('For example https://ds.example.com') },
      h('label', { className: 'bt-q-field' },
        h('input', {
          className: 'bt-q-input', type: 'url', value: url, placeholder: 'https://',
          autoComplete: 'url', spellCheck: false, onChange: event => setUrl(event.target.value),
        }))),
    h(Row, { label: t('Account') },
      h('label', { className: 'bt-q-field' },
        h('input', {
          className: 'bt-q-input', type: 'text', value: username, autoComplete: 'username',
          spellCheck: false, onChange: event => setUsername(event.target.value),
        }))),
    h(Row, { label: t('Password') },
      h('label', { className: 'bt-q-field' },
        h('input', {
          className: 'bt-q-input', type: 'password', value: password,
          autoComplete: 'current-password', 'aria-label': t('Password'),
          onChange: event => setPassword(event.target.value),
          onKeyDown: (event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            login()
          },
        }))),
    h('div', { className: 'bt-set-row' },
      h('div', { className: 'bt-set-copy' }),
      h('div', { className: 'bt-set-control' },
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm',
          disabled: busy || username.trim() === '' || password === '' || url.trim() === '',
          onClick: login,
        }, busy ? t('Signing in…') : t('Sign in and turn on')))),
    error ? h('div', { className: 'bt-connector-error', role: 'alert', style: { padding: '8px 12px' } }, error) : null)
}
