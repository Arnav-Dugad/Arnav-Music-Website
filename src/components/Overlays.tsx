import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon, Logo, type IconName } from './Icon'
import { Artwork, Sheet, Spinner, spring } from './ui'
import { PlaylistThumb } from './Shell'
import { useUi, ui, toast } from '../state/ui'
import { useLibrary, lib, visiblePlaylists, likedTracks, liveEvents } from '../state/library'
import { player, usePlayer, useProgress } from '../state/player'
import { useSettings } from '../state/settings'
import { trackRegistry } from '../state/tracks'
import { radioFor } from '../services/recs'
import { artworkFor } from '../lib/classify'
import { matchScore } from '../lib/query'
import { MOMENTS } from '../lib/moments'
import { authMessage, resetPassword, signInEmail, signInWithGoogle, signUpEmail } from '../lib/firebase'
import type { Track } from '../lib/types'
import { artistKey } from '../lib/types'

export async function startRadio(track: Track) {
  toast(`Starting ${track.artist} radio…`)
  const recs = await radioFor(track, { limit: 30 }).catch(() => [])
  player().play([track, ...recs.map((r) => r.track)], 0, { context: `${track.title} radio`, shuffle: false })
}

export function shareTrack(t: Track) {
  const url = `${location.origin}/track/${t.playbackRef}`
  const data = { title: `${t.title} — ${t.artist}`, text: `${t.title} by ${t.artist} on Arnav Music`, url }
  if (navigator.share && matchMedia('(hover: none)').matches) { void navigator.share(data).catch(() => undefined); return }
  void navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => toast(url))
}

function MenuItem({ icon, label, onClick, danger }: { icon: IconName; label: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button className={`menu-item ${danger ? 'danger' : ''}`} role="menuitem" onClick={() => { ui().set({ menu: null }); onClick() }}>
      <Icon name={icon} size={17} /> <span className="grow ellipsis">{label}</span>
    </button>
  )
}

export function TrackMenu() {
  const menu = useUi((s) => s.menu)
  const nav = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const liked = useLibrary((s) => (menu ? !!s.likes[menu.track.id] && !s.likes[menu.track.id].deleted : false))
  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null)
    const r = ref.current.getBoundingClientRect()
    const left = Math.min(Math.max(8, menu.x - (menu.x + r.width > innerWidth - 8 ? r.width : 0)), innerWidth - r.width - 8)
    const top = Math.min(Math.max(8, menu.y), innerHeight - r.height - 8)
    setPos({ left, top })
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ui().set({ menu: null }) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])
  const stats = useMemo(() => {
    if (!menu) return null
    const ev = liveEvents().filter((e) => e.trackId === menu.track.id)
    if (!ev.length) return null
    return `Played ${ev.length} ${ev.length === 1 ? 'time' : 'times'} · first ${new Date(Math.min(...ev.map((e) => e.startedAt))).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`
  }, [menu])
  const t = menu?.track
  return (
    <AnimatePresence>
      {menu && t && (
        <motion.div className="menu-root" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} onClick={() => ui().set({ menu: null })} onContextMenu={(e) => { e.preventDefault(); ui().set({ menu: null }) }}>
          <motion.div
            ref={ref}
            role="menu"
            className="menu glass-thick"
            style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 600, damping: 38 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="menu-head">
              <Artwork src={artworkFor(t, 'sm')} seed={t.artist} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 640, fontSize: 14 }}>{t.title}</div>
                <div className="ellipsis t-caption">{stats ?? t.artist}</div>
              </div>
            </div>
            <MenuItem icon="play" label="Play next" onClick={() => { player().playNext([t]); toast('Playing next') }} />
            <MenuItem icon="queue" label="Add to queue" onClick={() => { player().addToQueue([t]); toast('Added to queue') }} />
            <MenuItem icon="radio" label="Start radio" onClick={() => void startRadio(t)} />
            <div className="menu-sep" />
            <MenuItem icon="plus" label="Add to playlist…" onClick={() => ui().set({ addTo: [t] })} />
            <MenuItem icon={liked ? 'heartFill' : 'heart'} label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'} onClick={() => lib().toggleLike(t)} />
            <MenuItem icon="user" label={`Go to ${t.artist}`} onClick={() => { player().setExpanded(false); nav(`/artist/${encodeURIComponent(t.artist)}${t.channelId ? `?c=${t.channelId}` : ''}`) }} />
            {menu.playlistId && menu.playlistId.startsWith('arn_') && <MenuItem icon="minus" label="Remove from this playlist" onClick={() => lib().removeFromPlaylist(menu.playlistId!, t.id)} />}
            {menu.queueKey && <MenuItem icon="minus" label="Remove from queue" onClick={() => player().remove(menu.queueKey!)} />}
            <div className="menu-sep" />
            <MenuItem icon="share" label="Share" onClick={() => shareTrack(t)} />
            <MenuItem icon="youtube" label="Open on YouTube" onClick={() => window.open(`https://www.youtube.com/watch?v=${t.playbackRef}`, '_blank', 'noopener')} />
            <div className="menu-sep" />
            <MenuItem icon="close" label="Not interested" onClick={() => { lib().notInterestedIn(t.id); toast('You won’t see this in recommendations', { label: 'Undo', run: () => lib().unblock('track', t.id) }) }} />
            <MenuItem icon="close" label={`Don’t recommend ${t.artist}`} onClick={() => { lib().blockArtist(t.artist); toast(`${t.artist} won’t be recommended`, { label: 'Undo', run: () => lib().unblock('artist', artistKey(t.artist)) }) }} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function AddToPlaylist() {
  const tracks = useUi((s) => s.addTo)
  const playlists = useLibrary((s) => s.playlists)
  const list = useMemo(() => visiblePlaylists(playlists).filter((p) => p.kind === 'ARNAV'), [playlists])
  const [name, setName] = useState('')
  const close = () => { ui().set({ addTo: null }); setName('') }
  return (
    <Sheet open={!!tracks} onClose={close} title={tracks && tracks.length > 1 ? `Add ${tracks.length} songs to…` : 'Add to playlist'} width={460}>
      <form className="row" style={{ marginBottom: 12 }} onSubmit={(e) => {
        e.preventDefault()
        if (!tracks) return
        const id = lib().createPlaylist(name || 'New playlist', tracks)
        toast(`Added to ${name || 'New playlist'}`)
        close()
        void id
      }}>
        <input className="field" placeholder="New playlist name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-primary" type="submit"><Icon name="plus" size={16} /> Create</button>
      </form>
      <div className="col" style={{ gap: 2 }}>
        {list.map((p) => (
          <button key={p.id} className="menu-item" style={{ height: 54 }} onClick={() => {
            if (!tracks) return
            const n = lib().addToPlaylist(p.id, tracks)
            toast(n ? `Added to ${p.name}` : `Already in ${p.name}`)
            close()
          }}>
            <PlaylistThumb artwork={p.artworkUrl} trackIds={p.trackIds} name={p.name} />
            <span className="grow col" style={{ gap: 0 }}><span className="ellipsis">{p.name}</span><span className="t-caption">{p.trackIds.length} songs</span></span>
          </button>
        ))}
      </div>
    </Sheet>
  )
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} layout className="toast glass-thick" initial={{ opacity: 0, y: 18, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: 0.97 }} transition={spring}>
            <span>{t.text}</span>
            {t.action && <button className="btn btn-sm btn-secondary" onClick={() => { t.action!.run(); ui().dismiss(t.id) }}>{t.action.label}</button>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

interface PaletteItem { id: string; icon: IconName; label: string; hint?: string; art?: string | null; run: () => void; group: string }

export function CommandPalette() {
  const open = useUi((s) => s.palette)
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const playlists = useLibrary((s) => s.playlists)
  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 30) } }, [open])
  const close = () => ui().set({ palette: false })
  const go = (path: string) => () => { player().setExpanded(false); nav(path) }
  const items = useMemo<PaletteItem[]>(() => {
    const s = useSettings.getState()
    const base: PaletteItem[] = [
      { id: 'pp', group: 'Playback', icon: 'play', label: usePlayer.getState().wantPlaying ? 'Pause' : 'Play', hint: 'Space', run: () => player().toggle() },
      { id: 'nx', group: 'Playback', icon: 'nextFill', label: 'Next song', hint: '⇧→', run: () => player().next() },
      { id: 'pv', group: 'Playback', icon: 'prevFill', label: 'Previous song', hint: '⇧←', run: () => player().prev(useProgress.getState().position) },
      { id: 'sh', group: 'Playback', icon: 'shuffle', label: 'Toggle shuffle', hint: 'S', run: () => player().toggleShuffle() },
      { id: 'rp', group: 'Playback', icon: 'repeat', label: 'Cycle repeat', hint: 'R', run: () => player().cycleRepeat() },
      { id: 'np', group: 'Playback', icon: 'expand', label: 'Open Now Playing', hint: 'F', run: () => player().setExpanded(true) },
      { id: 'ly', group: 'Playback', icon: 'lyrics', label: 'Show lyrics', hint: 'Y', run: () => { player().setExpanded(true); if (player().panel !== 'lyrics') player().setPanel('lyrics') } },
      { id: 'qu', group: 'Playback', icon: 'queue', label: 'Show queue', hint: 'Q', run: () => { player().setExpanded(true); if (player().panel !== 'queue') player().setPanel('queue') } },
      { id: 'home', group: 'Go to', icon: 'home', label: 'Home', run: go('/') },
      { id: 'exp', group: 'Go to', icon: 'compass', label: 'Explore', run: go('/explore') },
      { id: 'ai', group: 'Go to', icon: 'sparkles', label: 'Arnav AI', run: go('/ai') },
      { id: 'mom', group: 'Go to', icon: 'moments', label: 'Moments', run: go('/moments') },
      { id: 'lib', group: 'Go to', icon: 'library', label: 'Library', run: go('/library') },
      { id: 'liked', group: 'Go to', icon: 'heartFill', label: 'Liked Songs', run: go('/playlist/liked') },
      { id: 'dna', group: 'Go to', icon: 'chart', label: 'Taste DNA', run: go('/insights') },
      { id: 'set', group: 'Go to', icon: 'gear', label: 'Settings', run: go('/settings') },
      { id: 'theme', group: 'Settings', icon: s.themeMode === 'light' ? 'moon' : 'sun', label: s.themeMode === 'light' ? 'Switch to dark appearance' : 'Switch to light appearance', run: () => useSettings.getState().update({ themeMode: s.themeMode === 'light' ? 'dark' : 'light' }) },
      { id: 'keys', group: 'Settings', icon: 'keyboard', label: 'Keyboard shortcuts', hint: '?', run: () => ui().set({ shortcutsOpen: true }) },
      ...MOMENTS.map((m) => ({ id: `m-${m.id}`, group: 'Moments', icon: 'moments' as IconName, label: m.title, hint: m.subtitle, run: go(`/moment/${m.id}`) })),
    ]
    return base
  }, [open, playlists]) // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo<PaletteItem[]>(() => {
    const query = q.trim()
    if (!query) return items.filter((i) => i.group !== 'Moments').slice(0, 14)
    const scored = items.map((i) => ({ i, s: Math.max(matchScore(query, i.label), i.hint ? matchScore(query, i.hint) * 0.7 : 0) })).filter((x) => x.s > 0.4)
    const pls = visiblePlaylists(playlists).map((p) => ({ i: { id: `pl-${p.id}`, group: 'Your library', icon: 'note' as IconName, label: p.name, hint: `${p.trackIds.length} songs`, run: go(`/playlist/${p.id}`) }, s: matchScore(query, p.name) })).filter((x) => x.s > 0.5)
    const known = [...likedTracks(), ...trackRegistry.all().slice(-800)]
    const seen = new Set<string>()
    const songs = known.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
      .map((t) => ({ t, s: Math.max(matchScore(query, t.title), matchScore(query, `${t.title} ${t.artist}`), matchScore(query, t.artist) * 0.8) }))
      .filter((x) => x.s >= 0.55).sort((a, b) => b.s - a.s).slice(0, 6)
      .map(({ t, s }) => ({ i: { id: `t-${t.id}`, group: 'Songs', icon: 'note' as IconName, label: t.title, hint: t.artist, art: artworkFor(t, 'sm'), run: () => player().play([t], 0, { context: 'Search' }) }, s }))
    const tail: PaletteItem[] = [
      { id: 'search', group: 'Search', icon: 'search', label: `Search for “${query}”`, run: go(`/explore?q=${encodeURIComponent(query)}`) },
      { id: 'askai', group: 'Search', icon: 'sparkles', label: `Ask Arnav AI: “${query}”`, run: go(`/ai?q=${encodeURIComponent(query)}`) },
    ]
    return [...tail.slice(0, 1), ...songs.map((x) => x.i), ...[...scored, ...pls].sort((a, b) => b.s - a.s).map((x) => x.i).slice(0, 8), tail[1]]
  }, [q, items, playlists]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setSel(0), [q])
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
    if (e.key === 'Enter') { e.preventDefault(); const r = results[sel]; if (r) { close(); r.run() } }
    if (e.key === 'Escape') close()
  }
  let lastGroup = ''
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="palette-root" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={close}>
          <motion.div className="palette glass-thick" initial={{ opacity: 0, y: -14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10, scale: 0.98 }} transition={spring} onClick={(e) => e.stopPropagation()}>
            <div className="palette-input">
              <Icon name="search" size={19} />
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search songs, commands, moments — or ask Arnav AI" aria-label="Command palette" />
              <span className="kbd">esc</span>
            </div>
            <div className="palette-list" role="listbox">
              {results.map((r, i) => {
                const head = r.group !== lastGroup ? r.group : null
                lastGroup = r.group
                return (
                  <div key={r.id}>
                    {head && <div className="palette-group t-eyebrow">{head}</div>}
                    <button role="option" aria-selected={i === sel} className={`palette-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => { close(); r.run() }}>
                      {r.art ? <Artwork src={r.art} className="palette-art" /> : <span className="palette-icon"><Icon name={r.icon} size={16} /></span>}
                      <span className="grow ellipsis">{r.label}</span>
                      {r.hint && <span className="t-caption ellipsis" style={{ maxWidth: 220 }}>{r.hint}</span>}
                    </button>
                  </div>
                )
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'], ['⇧ →', 'Next song'], ['⇧ ←', 'Previous song'], ['→ / ←', 'Seek 5 seconds'], ['↑ / ↓', 'Volume'],
  ['M', 'Mute'], ['L', 'Like the current song'], ['S', 'Shuffle'], ['R', 'Repeat'], ['F', 'Now Playing'], ['Y', 'Lyrics'], ['Q', 'Queue'],
  ['⌘ K / Ctrl K', 'Command palette'], ['/', 'Search'], ['?', 'This list'],
]

export function ShortcutsSheet() {
  const open = useUi((s) => s.shortcutsOpen)
  return (
    <Sheet open={open} onClose={() => ui().set({ shortcutsOpen: false })} title="Keyboard shortcuts" width={460}>
      <div className="col" style={{ gap: 0 }}>
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="row" style={{ justifyContent: 'space-between', padding: '9px 2px', borderBottom: '1px solid var(--hairline)' }}>
            <span className="muted">{v}</span><span className="kbd">{k}</span>
          </div>
        ))}
      </div>
    </Sheet>
  )
}

/** Global keyboard shortcuts (ignored while typing). */
export function useShortcuts() {
  const nav = useNavigate()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ui().set({ palette: !useUi.getState().palette }); return }
      if (el.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (useUi.getState().palette) return
      const p = player()
      const pos = useProgress.getState().position
      switch (e.key) {
        case ' ': if (el.closest('button, a, [role="button"]')) return; e.preventDefault(); p.toggle(); break
        case 'ArrowRight': if (el.closest('[role="slider"]')) return; e.preventDefault(); if (e.shiftKey) p.next(); else p.seek(pos + 5000); break
        case 'ArrowLeft': if (el.closest('[role="slider"]')) return; e.preventDefault(); if (e.shiftKey) p.prev(pos); else p.seek(pos - 5000); break
        case 'ArrowUp': if (!usePlayer.getState().expanded) return; e.preventDefault(); p.setVolume(usePlayer.getState().volume + 5); break
        case 'ArrowDown': if (!usePlayer.getState().expanded) return; e.preventDefault(); p.setVolume(usePlayer.getState().volume - 5); break
        case 'm': case 'M': p.toggleMute(); break
        case 's': case 'S': p.toggleShuffle(); toast(usePlayer.getState().shuffle ? 'Shuffle on' : 'Shuffle off'); break
        case 'r': case 'R': p.cycleRepeat(); toast(`Repeat ${usePlayer.getState().repeat}`); break
        case 'f': case 'F': p.setExpanded(!usePlayer.getState().expanded); break
        case 'y': case 'Y': p.setExpanded(true); p.setPanel('lyrics'); break
        case 'q': case 'Q': p.setExpanded(true); p.setPanel('queue'); break
        case 'l': case 'L': { const t = usePlayer.getState().queue[usePlayer.getState().index]?.track; if (t) toast(lib().toggleLike(t) ? 'Added to Liked Songs' : 'Removed from Liked Songs'); break }
        case '/': e.preventDefault(); p.setExpanded(false); nav('/explore?focus=1'); break
        case '?': ui().set({ shortcutsOpen: true }); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav])
}

export function AuthSheet() {
  const open = useUi((s) => s.authOpen)
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const close = () => { ui().set({ authOpen: false }); setError(null) }
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key); setError(null)
    try { await fn(); if (done) toast(done); close() } catch (e) { setError(authMessage(e)) } finally { setBusy(null) }
  }
  return (
    <Sheet open={open} onClose={close} width={430}>
      <div className="col" style={{ alignItems: 'center', textAlign: 'center', gap: 10, padding: '6px 4px 2px' }}>
        <Logo size={56} glow />
        <div className="t-title" style={{ marginTop: 6 }}>{mode === 'in' ? 'Sign in to Arnav Music' : 'Create your account'}</div>
        <div className="t-sub" style={{ maxWidth: 330 }}>Same account as the Android app — your likes, playlists and listening history follow you.</div>
      </div>
      <div className="col" style={{ gap: 10, marginTop: 18 }}>
        <button className="btn btn-secondary btn-lg" disabled={!!busy} onClick={() => void run('g', signInWithGoogle, 'Signed in')}>
          {busy === 'g' ? <Spinner /> : <Icon name="google" size={18} />} Continue with Google
        </button>
        <div className="row" style={{ gap: 10, margin: '6px 0' }}><hr className="divider grow" /><span className="t-caption">or</span><hr className="divider grow" /></div>
        <form className="col" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); void run('e', () => (mode === 'in' ? signInEmail(email, password) : signUpEmail(name, email, password)), mode === 'in' ? 'Signed in' : 'Welcome to Arnav Music') }}>
          {mode === 'up' && <input className="field" placeholder="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />}
          <input className="field" type="email" placeholder="Email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="field" type="password" placeholder="Password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && <div className="notice error" style={{ fontSize: 13 }}><Icon name="info" size={16} />{error}</div>}
          <button className="btn btn-primary btn-lg" type="submit" disabled={!!busy}>{busy === 'e' ? <Spinner /> : mode === 'in' ? 'Sign in' : 'Create account'}</button>
        </form>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 4 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null) }}>{mode === 'in' ? 'Create an account' : 'I have an account'}</button>
          {mode === 'in' && <button className="btn btn-ghost btn-sm" disabled={!email || !!busy} onClick={() => void run('r', () => resetPassword(email), 'Password reset email sent')}>Forgot password?</button>}
        </div>
      </div>
    </Sheet>
  )
}
