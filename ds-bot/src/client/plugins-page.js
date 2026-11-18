import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { Switch } from './bot-settings.js'
import { t } from './i18n.js'

// Settings → Plugins. A third-party bundle can carry its own on/off switch in the profile
// patch (`config.enabled`); this page flips that value in place, so a bundle that would
// otherwise rewrite itself back on every upgrade can be turned off without uninstalling.
// A bundle without such a key is not listed: there is nothing safe to write for it. The
// value is read when the bundle loads, so a change takes effect the next time DS Bot starts.
export function PluginsPage({ actions, Section, Row }) {
  const [plugins, setPlugins] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const alive = useRef(true)

  const refresh = useCallback(() => {
    actionsRef.current.pluginsStatus()
      .then((next) => { if (alive.current) setPlugins(next?.plugins ?? []) })
      .catch(failure => { if (alive.current) setError(failure?.message ?? String(failure)) })
  }, [])

  useEffect(() => {
    alive.current = true
    refresh()
    return () => { alive.current = false }
  }, [refresh])

  const flip = (row, enabled) => {
    const key = `${row.profile}/${row.name}`
    if (busy !== '') return
    setBusy(key)
    setError('')
    actions.pluginSetEnabled(row.profile, row.name, enabled)
      .then((next) => {
        if (!alive.current) return
        setPlugins(current => (current ?? []).map(entry => (entry.profile === next.profile && entry.name === next.name ? { ...entry, enabled: next.enabled } : entry)))
      })
      .catch(failure => { if (alive.current) setError(failure?.message ?? String(failure)) })
      .finally(() => { if (alive.current) setBusy('') })
  }

  if (plugins === null) {
    return h(Section, { title: t('Plugin switches') }, h('p', { className: 'bt-set-hint' }, t('Checking…')))
  }

  if (plugins.length === 0) {
    return h(Section, { title: t('Plugin switches') },
      h('p', { className: 'bt-set-hint' }, t('No plug-in in this profile has an on/off switch.')),
      error ? h('div', { className: 'bt-connector-error', role: 'alert', style: { padding: '8px 12px' } }, error) : null)
  }

  return h(Section, { title: t('Plugin switches') },
    h('p', { className: 'bt-set-hint' }, t('Turn a plug-in off to stop it loading the next time DS Bot starts.')),
    plugins.map(row => h(Row, { key: `${row.profile}/${row.name}`, label: row.name, hint: row.profile },
      h(Switch, {
        on: row.enabled,
        label: row.name,
        disabled: busy === `${row.profile}/${row.name}`,
        onChange: enabled => flip(row, enabled),
      }))),
    error ? h('div', { className: 'bt-connector-error', role: 'alert', style: { padding: '8px 12px' } }, error) : null)
}
