// The phone shell is the PC window's own frame (app/ui/src/app.js), narrowed: the same
// TeamSidebar, HeaderPill, Chat and overlays, with one pane on screen at a time. On a
// wide screen it behaves exactly like the desktop window.
import { Component, createElement as h, Fragment, useEffect, useMemo, useState } from 'react'
import { ErrorToast } from '../../ds-bot/src/client/feedback.js'
import { HeaderPill } from '../../ds-bot/src/client/header.js'
import { t } from '../../ds-bot/src/client/i18n.js'
import { Overlays } from '../../ds-bot/src/client/overlays.js'
import { BrandMark, TeamSidebar, YouAvatar } from '../../ds-bot/src/client/sidebar.js'
import { allThemes, themeCss } from '../../ds-bot/src/client/themes.js'
import { Chat } from '../../app/ui/src/chat.js'
import { createTeam } from '../../app/ui/src/team.js'

// The team's theme and accent, as the plugin paints them.
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

// A dialog or panel that fails closes, and the failure shows as a toast; the page stays.
class Contain extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
    this.failedAt = 0
  }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error) {
    this.props.onError(error)
    if (Date.now() - this.failedAt > 1000) this.setState({ failed: false })
    this.failedAt = Date.now()
  }

  render() { return this.state.failed ? null : this.props.children }
}

function useMedia(query) {
  const [matches, setMatches] = useState(() => globalThis.matchMedia?.(query).matches === true)
  useEffect(() => {
    const media = matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

export function App() {
  const team = useMemo(createTeam, [])
  useEffect(() => team.start(), [team])
  const { hooks, actions } = team
  const narrow = useMedia('(max-width: 760px)')
  const widePref = hooks.useLayout(state => state.wide)
  const shown = hooks.useShown(id => id)
  // The window lands on the Main Bot whenever the main view is empty. On a phone that would
  // undo the back button at once, so the list holds the view until a row opens a Session.
  const [listing, setListing] = useState(false)
  const shellActions = useMemo(() => ({
    ...actions,
    landOn: id => { if (!listing) actions.landOn(id) },
    openSession: id => { setListing(false); return actions.openSession(id) },
    openAgent: id => { setListing(false); return actions.openAgent(id) },
    openAgentSession: id => { setListing(false); return actions.openAgentSession(id) },
    newAgentSession: id => { setListing(false); return actions.newAgentSession(id) },
    showList: () => {
      setListing(true)
      actions.closeSession()
    },
  }), [actions, listing])
  const views = { ...hooks, actions: shellActions }
  // On a phone the list fills the screen until a conversation opens, so the sidebar keeps
  // its full form: the rail the window collapses to is too narrow to read a Bot's name.
  const wide = narrow || widePref
  useTheme(hooks.useRoster(value => value.prefs))
  const closeOverlays = (error) => {
    actions.closeSettings()
    actions.closeMemory()
    actions.closeMenu()
    actions.closePanel()
    actions.closePalette()
    actions.closeVoice()
    actions.closeOverlay()
    actions.reportError(error, 'overlay')
  }
  return h('div', {
    className: 'dsb-frame',
    'data-mobile': narrow ? '' : undefined,
    'data-view': narrow ? (shown ? 'chat' : 'list') : undefined,
    'data-rail': !narrow && !widePref ? '' : undefined,
  },
    h('aside', { className: 'dsb-side' },
      h('div', { className: 'dsb-band' }),
      h('div', { className: 'dsb-side-list' },
        wide ? null : h('button', { type: 'button', className: 'dsb-expand', 'aria-label': t('Expand sidebar'), title: t('Expand sidebar'), onClick: () => actions.toggleSidebar() }, h(BrandMark, { size: 22 })),
        h(TeamSidebar, { ...views, wide })),
      h('div', { className: 'dsb-side-foot' },
        narrow ? h('button', { type: 'button', className: 'm-switch', onClick: () => location.assign('/devices') }, t('Switch device')) : null,
        h('button', { type: 'button', className: 'dsb-settings', title: t('Settings'), onClick: () => actions.openSettings() }, h(YouAvatar)))),
    // The details panel makes room by giving the shell's `_centerCol` column a right margin.
    h('main', { className: 'dsb-main dsb_centerCol' },
      h('div', { className: 'dsb-band' }),
      shown ? h(Fragment, { key: shown },
        narrow ? h('button', { type: 'button', className: 'm-back', 'aria-label': t('Back'), title: t('Back'), onClick: () => shellActions.showList() }, '‹') : null,
        h('div', { className: 'dsb-head' }, h(HeaderPill, { ...views, sessionId: shown, useSession: team.sessionHook(shown) })),
        h(Chat, { sessionId: shown, team })) : null),
    h(Contain, { onError: closeOverlays }, h(Overlays, views)),
    h(ErrorToast, views))
}
