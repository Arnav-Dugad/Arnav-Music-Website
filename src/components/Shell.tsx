import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Icon, Logo, type IconName } from './Icon'
import { Artwork, spring } from './ui'
import { useLibrary, visiblePlaylists } from '../state/library'
import { useAuth } from '../state/auth'
import { ui } from '../state/ui'
import { useSync } from '../services/sync'
import { useMemo } from 'react'
import { trackRegistry } from '../state/tracks'
import { artworkFor } from '../lib/classify'
import { useSocial } from '../services/social'

export const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/explore', label: 'Explore', icon: 'compass' },
  { to: '/ai', label: 'Arnav AI', icon: 'sparkles' },
  { to: '/moments', label: 'Moments', icon: 'moments' },
  { to: '/library', label: 'Library', icon: 'library' },
]

export function Sidebar() {
  const nav = useNavigate()
  const loc = useLocation()
  const playlists = useLibrary((s) => s.playlists)
  const list = useMemo(() => visiblePlaylists(playlists).slice(0, 40), [playlists])
  const user = useAuth((s) => s.user)
  const status = useSync((s) => s.status)
  return (
    <aside className="sidebar glass-thin">
      <button className="sb-brand" onClick={() => nav('/')} aria-label="Arnav Music home">
        <Logo size={30} />
        <span className="t-brand">Arnav Music</span>
      </button>
      <button className="sb-search" onClick={() => ui().set({ palette: true })}>
        <Icon name="search" size={16} />
        <span className="grow">Search</span>
        <span className="kbd">⌘K</span>
      </button>
      <nav className="sb-nav" aria-label="Main">
        {NAV.map((n) => {
          const active = n.end ? loc.pathname === n.to : loc.pathname.startsWith(n.to)
          return (
            <NavLink key={n.to} to={n.to} end={n.end} className={`sb-link ${active ? 'active' : ''}`}>
              {active && <motion.span layoutId="sb-active" className="sb-pill" transition={spring} />}
              <Icon name={n.icon} size={19} />
              <span>{n.label}</span>
            </NavLink>
          )
        })}
        <NavLink to="/insights" className={`sb-link ${loc.pathname.startsWith('/insights') ? 'active' : ''}`}>
          {loc.pathname.startsWith('/insights') && <motion.span layoutId="sb-active" className="sb-pill" transition={spring} />}
          <Icon name="chart" size={19} />
          <span>Taste DNA</span>
        </NavLink>
        <NavLink to="/together" className={`sb-link ${loc.pathname.startsWith('/together') ? 'active' : ''}`}>
          {loc.pathname.startsWith('/together') && <motion.span layoutId="sb-active" className="sb-pill" transition={spring} />}
          <Icon name="radio" size={19} />
          <span>Listen together</span>
        </NavLink>
        <NavLink to="/friends" className={`sb-link ${/^\/(friends|u\/|add\/)/.test(loc.pathname) ? 'active' : ''}`}>
          {/^\/(friends|u\/|add\/)/.test(loc.pathname) && <motion.span layoutId="sb-active" className="sb-pill" transition={spring} />}
          <Icon name="users" size={19} />
          <span className="grow">Friends</span>
          <FriendsBadge />
        </NavLink>
      </nav>
      <div className="sb-section">
        <div className="sb-section-head">
          <span className="t-eyebrow">Playlists</span>
          <button className="icon-btn sm" aria-label="New playlist" onClick={() => { const id = useLibrary.getState().createPlaylist('New playlist'); nav(`/playlist/${id}?edit=1`) }}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        <div className="sb-playlists">
          <NavLink to="/playlist/liked" className="sb-pl">
            <span className="sb-pl-art liked"><Icon name="heartFill" size={14} /></span>
            <span className="ellipsis">Liked Songs</span>
          </NavLink>
          {list.map((p) => (
            <NavLink key={p.id} to={`/playlist/${p.id}`} className="sb-pl">
              <PlaylistThumb artwork={p.artworkUrl} trackIds={p.trackIds} name={p.name} />
              <span className="ellipsis">{p.name}</span>
              {p.pinned && <Icon name="pin" size={12} className="subtle" />}
            </NavLink>
          ))}
        </div>
      </div>
      <div className="sb-foot">
        <NavLink to="/settings" className={`sb-account ${loc.pathname.startsWith('/settings') ? 'active' : ''}`}>
          {user?.photoURL ? <img src={user.photoURL} alt="" className="avatar" referrerPolicy="no-referrer" /> : <span className="avatar ph"><Icon name="user" size={15} /></span>}
          <span className="grow col" style={{ gap: 0 }}>
            <span className="ellipsis" style={{ fontWeight: 600, fontSize: 13.5 }}>{user ? user.displayName || user.email : 'Guest'}</span>
            <span className="ellipsis t-caption">{user ? syncLabel(status) : 'Sign in to sync with your phone'}</span>
          </span>
          <Icon name="gear" size={17} className="subtle" />
        </NavLink>
      </div>
    </aside>
  )
}

/** Requests waiting + unread songs, or how many friends are playing music right now. */
function FriendsBadge() {
  const pending = useSocial((s) => s.incoming.length + s.unread)
  const live = useSocial((s) => Object.values(s.presence).filter((p) => p.now?.playing).length)
  if (pending) return <span className="sc-badge">{pending > 9 ? '9+' : pending}</span>
  if (live) return <span className="sb-live" title={`${live} friend${live > 1 ? 's' : ''} listening now`}><i />{live}</span>
  return null
}

/** Phones: Friends takes the Moments slot (Moments stays in Home and ⌘K). */
const TABS: typeof NAV = [NAV[0], NAV[1], { to: '/friends', label: 'Friends', icon: 'users' }, NAV[2], NAV[4]]

export function syncLabel(s: string) {
  switch (s) {
    case 'SYNCING': return 'Syncing…'
    case 'UP_TO_DATE': return 'Synced with your devices'
    case 'OFFLINE': return 'Offline — will sync later'
    case 'ERROR': return 'Sync needs attention'
    case 'ACCOUNT_BLOCKED': return 'Sync paused — account mismatch'
    case 'DISABLED': return 'Cloud sync is off'
    default: return 'Signed in'
  }
}


export function PlaylistThumb({ artwork, trackIds, name, size = 'sm' }: { artwork?: string | null; trackIds: string[]; name: string; size?: 'sm' | 'lg' }) {
  const arts = useMemo(() => {
    if (artwork) return [artwork]
    const ts = trackRegistry.many(trackIds.slice(0, 12))
    return [...new Set(ts.map((t) => artworkFor(t, 'sm')))].slice(0, 4)
  }, [artwork, trackIds])
  if (arts.length >= 4) {
    return (
      <span className={`pl-thumb quad ${size}`}>
        {arts.map((a) => <Artwork key={a} src={a} letterbox={false} />)}
      </span>
    )
  }
  return <span className={`pl-thumb ${size}`}><Artwork src={arts[0]} seed={name} icon="note" /></span>
}

function TabDot() {
  const pending = useSocial((s) => s.incoming.length + s.unread)
  return pending ? <i className="tab-dot" aria-label={`${pending} new`} /> : null
}

export function TabBar() {
  const loc = useLocation()
  return (
    <nav className="tabbar glass-thick" aria-label="Main">
      {TABS.map((n) => {
        const active = n.end ? loc.pathname === n.to : n.to === '/friends' ? /^\/(friends|u\/|add\/)/.test(loc.pathname) : loc.pathname.startsWith(n.to)
        return (
          <NavLink key={n.to} to={n.to} end={n.end} className={`tab ${active ? 'active' : ''}`}
            onClick={() => { if (active) document.querySelector('.main-scroll')?.scrollTo({ top: 0, behavior: 'smooth' }) }}>
            <motion.span animate={{ scale: active ? 1 : 0.94, y: active ? -1 : 0 }} transition={spring} className="tab-icon">
              <Icon name={n.icon} size={22} strokeWidth={active ? 2.1 : 1.8} />
              {n.to === '/friends' && <TabDot />}
            </motion.span>
            <span className="tab-label">{n.label === 'Arnav AI' ? 'AI' : n.label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}
