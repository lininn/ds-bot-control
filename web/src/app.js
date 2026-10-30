import { createElement as h, Fragment, useEffect, useMemo, useState } from 'react'
import { ErrorToast } from '../../ds-bot/src/client/feedback.js'
import { t } from '../../ds-bot/src/client/i18n.js'
import { allThemes, themeCss } from '../../ds-bot/src/client/themes.js'
import { Chat } from '../../app/ui/src/chat.js'
import { createTeam } from '../../app/ui/src/team.js'

// The team's theme and accent, as the plugin paints them. Chat inherits its --bt-* colors
// from this style, so it must run before the views draw.
function useTheme(prefs) {
  useEffect(() => {
    const theme = allThemes()[prefs?.theme] ?? allThemes().deepseek
    const style = document.createElement('style')
    style.textContent = themeCss(theme, prefs?.accent)
    document.head.append(style)
    if (prefs?.motion) document.body.dataset.btMotion = prefs.motion
    else delete document.body.dataset.btMotion
    return () => { style.remove() }
  }, [prefs?.theme, prefs?.accent, prefs?.motion])
}

// The Bot list: one tap opens that Bot's own chat.
function TeamList({ roster, onOpen }) {
  const bots = roster.bots ?? []
  if (!roster.ready) return h('div', { className: 'm-list m-list-empty' }, h('span', null, t('Loading…')))
  return h('div', { className: 'm-list', role: 'list' },
    bots.map(bot => h('button', {
      key: bot.id,
      type: 'button',
      role: 'listitem',
      className: 'm-bot',
      onClick: () => onOpen(bot.id),
    },
    h('span', { className: 'm-bot-dot', 'data-color': bot.color ?? undefined }),
    h('span', { className: 'm-bot-text' },
      h('span', { className: 'm-bot-name' }, bot.name ?? ''),
      bot.role ? h('span', { className: 'm-bot-role' }, bot.role) : null))))
}

export function App() {
  const team = useMemo(createTeam, [])
  useEffect(() => team.start(), [team])
  const { hooks, actions } = team
  const roster = hooks.useRoster(value => value)
  useTheme(roster.prefs)
  const [openId, setOpenId] = useState(null)
  const bot = openId ? roster.byId[openId] : undefined
  // A Bot's current part is the Session its own chat reads.
  const sessionId = bot ? (bot.sessionId ?? bot.id) : undefined
  const views = { ...hooks, actions }

  return h('div', { className: 'm-app' },
    openId === null
      ? h(Fragment, null,
        h('header', { className: 'm-bar m-bar-root' },
          h('span', { className: 'm-bar-title' }, t('DS Bot')),
          h('button', {
            type: 'button',
            className: 'm-switch',
            title: t('Switch device'),
            onClick: () => location.assign('/devices'),
          }, t('Switch device'))),
        h('main', { className: 'm-main' }, h(TeamList, { roster, onOpen: setOpenId })))
      : h(Fragment, null,
        h('header', { className: 'm-bar' },
          h('button', { type: 'button', className: 'm-back', 'aria-label': t('Back'), onClick: () => setOpenId(null) }, '‹'),
          h('span', { className: 'm-bar-title' }, bot?.name ?? '')),
        h('main', { className: 'm-main m-main-chat' }, h(Chat, { key: sessionId, sessionId, team }))),
    h(ErrorToast, views))
}
