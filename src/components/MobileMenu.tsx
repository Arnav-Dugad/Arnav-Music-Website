/**
 * Phones: everything that lives in the desktop sidebar (Settings, Taste DNA, Moments, Listen
 * together, Wrapped, the album wall…) behind one profile button, top-right on the main tabs.
 */
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { create } from 'zustand'
import { Icon, type IconName } from './Icon'
import { Sheet } from './ui'
import { useAuth } from '../state/auth'
import { ui } from '../state/ui'
import { useSync } from '../services/sync'
import { useSocial } from '../services/social'
import { syncLabel } from './Shell'

export const useMoreMenu = create<{ open: boolean; set: (open: boolean) => void }>()((set) => ({ open: false, set: (open) => set({ open }) }))

const PLACES: { to: string; label: string; sub: string; icon: IconName; tint: string }[] = [
  { to: '/insights', label: 'Taste DNA', sub: 'Your listening, understood', icon: 'chart', tint: '#4cc9f0' },
  { to: '/moments', label: 'Moments', sub: 'Immersive scenes + music', icon: 'moments', tint: '#ffa62b' },
  { to: '/together', label: 'Listen together', sub: 'Same song, same second', icon: 'radio', tint: '#3ddc97' },
  { to: '/friends', label: 'Friends', sub: 'Listening now, inbox', icon: 'users', tint: '#f72585' },
  { to: '/wrapped', label: 'Your Wrapped', sub: 'This month as a story', icon: 'story', tint: '#7b2ff7' },
  { to: '/wall', label: 'Album wall', sub: 'Fly through your covers', icon: 'wall', tint: '#ffd23f' },
]

/** The round profile button (top-right on Home, Explore, Friends, AI and Library). */
export function MobileAccountButton() {
  const loc = useLocation()
  const user = useAuth((s) => s.user)
  const pending = useSocial((s) => s.incoming.length + s.unread)
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const el = document.querySelector('.main-scroll')
    if (!el) return
    const on = () => setScrolled(el.scrollTop > 24)
    on()
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [loc.pathname])
  // Only on the five main tabs, where there's no back button in the corner.
  // Home has its own top bar with the profile button.
  if (!/^\/(explore|search|friends|ai|library)$/.test(loc.pathname)) return null
  const initial = (user?.displayName || user?.email || '').trim()[0]?.toUpperCase()
  return (
    <motion.button className={`m-account ${scrolled ? 'scrolled' : ''}`} aria-label="Settings and more" onClick={() => useMoreMenu.getState().set(true)}
      initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} whileTap={{ scale: 0.9 }}>
      {user?.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : initial ? <span>{initial}</span> : <Icon name="user" size={18} />}
      {pending > 0 && <i className="m-account-dot" aria-label={`${pending} new`} />}
    </motion.button>
  )
}

/** "More": your account, settings and every other page. */
export function MoreSheet() {
  const nav = useNavigate()
  const open = useMoreMenu((s) => s.open)
  const set = useMoreMenu((s) => s.set)
  const user = useAuth((s) => s.user)
  const status = useSync((s) => s.status)
  const pending = useSocial((s) => s.incoming.length + s.unread)
  const go = (to: string) => { set(false); nav(to) }
  return (
    <Sheet open={open} onClose={() => set(false)} title="More" width={460} className="m-more">
      <button className="m-me" onClick={() => (user ? go('/settings/account') : (set(false), ui().set({ authOpen: true })))}>
        <span className="m-me-avatar">{user?.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : <Icon name="user" size={20} />}</span>
        <span className="col" style={{ gap: 2, minWidth: 0, flex: 1, textAlign: 'left' }}>
          <b className="ellipsis">{user ? user.displayName || user.email : 'Guest'}</b>
          <span className="t-caption ellipsis">{user ? syncLabel(status) : 'Sign in to sync with your phone app'}</span>
        </span>
        <span className="chip">{user ? 'Account' : 'Sign in'}</span>
      </button>
      <div className="m-grid">
        {PLACES.map((p, i) => (
          <motion.button key={p.to} className="m-tile" style={{ ['--t' as string]: p.tint }} onClick={() => go(p.to)}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.03 * i, type: 'spring', stiffness: 380, damping: 30 }}>
            <span className="m-tile-icon"><Icon name={p.icon} size={19} /></span>
            <b>{p.label}</b>
            <span className="t-caption">{p.sub}</span>
            {p.to === '/friends' && pending > 0 && <span className="sc-badge m-tile-badge">{pending}</span>}
          </motion.button>
        ))}
      </div>
      <div className="m-list">
        <button onClick={() => go('/settings')}><Icon name="gear" size={18} /><span className="grow">Settings</span><Icon name="chevronRight" size={16} className="subtle" /></button>
        <button onClick={() => go('/settings/playback')}><Icon name="play" size={18} /><span className="grow">Playback & automix</span><Icon name="chevronRight" size={16} className="subtle" /></button>
        <button onClick={() => go('/settings/lyrics')}><Icon name="lyrics" size={18} /><span className="grow">Lyrics</span><Icon name="chevronRight" size={16} className="subtle" /></button>
        <button onClick={() => go('/settings/sync')}><Icon name="cloud" size={18} /><span className="grow">Data & sync</span><Icon name="chevronRight" size={16} className="subtle" /></button>
        <button onClick={() => { set(false); ui().set({ phoneOpen: true }) }}><Icon name="phone" size={18} /><span className="grow">Continue on another device</span><Icon name="chevronRight" size={16} className="subtle" /></button>
      </div>
    </Sheet>
  )
}
