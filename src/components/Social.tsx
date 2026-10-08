/** Friends UI pieces shared across pages: avatars, live "listening now" cards, the send sheet. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { create } from 'zustand'
import { Icon } from './Icon'
import { Artwork, Eq, Sheet, Spinner } from './ui'
import { artworkFor } from '../lib/classify'
import { duration, relative } from '../lib/format'
import { toast } from '../state/ui'
import { player } from '../state/player'
import { asTrack, hasProfile, inviteToRoom, listenAlong, livePosition, openRoom, shareWith, stopListeningAlong, useSocial, wave, type NowPlaying, type Person, type PersonView } from '../services/social'
import { useTogether } from '../services/together'
import type { Track } from '../lib/types'

export function Avatar({ p, size = 40, ring = false, online }: { p: Pick<Person, 'name' | 'avatar' | 'color'>; size?: number; ring?: boolean; online?: boolean }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className={`sc-avatar ${ring ? 'ring' : ''}`} style={{ width: size, height: size, ['--c' as string]: p.color, fontSize: size * 0.42 }}>
      {p.avatar && !broken ? <img src={p.avatar} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <span>{(p.name.trim()[0] ?? '♪').toUpperCase()}</span>}
      {online !== undefined && <i className={`sc-dot ${online ? 'on' : ''}`} aria-label={online ? 'Online' : 'Offline'} />}
    </span>
  )
}

export function AvatarStack({ people, size = 24, max = 4 }: { people: Pick<Person, 'id' | 'name' | 'avatar' | 'color'>[]; size?: number; max?: number }) {
  return (
    <span className="sc-stack" style={{ ['--s' as string]: `${size}px` }}>
      {people.slice(0, max).map((p) => <Avatar key={p.id} p={p} size={size} />)}
      {people.length > max && <span className="sc-more">+{people.length - max}</span>}
    </span>
  )
}

/** A friend's song moving in real time (a 4 Hz tick is plenty for a thin bar). */
export function useLiveProgress(now: NowPlaying | null) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!now?.playing) return
    const t = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [now?.playing, now?.at])
  if (!now?.track) return { pos: 0, pct: 0 }
  const pos = livePosition(now)
  const d = now.track.durationMs ?? 0
  return { pos: d ? Math.min(pos, d) : pos, pct: d ? Math.min(1, pos / d) : 0 }
}

/** "Listening now": one friend's live song, with listen-along, join and wave. */
export function NowCard({ f, compact = false }: { f: PersonView; compact?: boolean }) {
  const nav = useNavigate()
  const pres = useSocial((s) => s.presence[f.id])
  const following = useSocial((s) => s.following === f.id)
  const myRoom = useTogether((s) => (s.status === 'live' ? s.code : null))
  const now = pres?.now ?? f.now
  const online = pres?.online ?? f.online
  const { pos, pct } = useLiveProgress(now)
  if (!now?.track) return null
  const t = now.track
  return (
    <motion.article layout className={`sc-now glass ${compact ? 'compact' : ''} ${following ? 'following' : ''}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}>
      <div className="sc-now-bg" aria-hidden><img src={t.artworkUrl ?? `https://i.ytimg.com/vi/${t.playbackRef}/mqdefault.jpg`} alt="" /></div>
      <button className="sc-now-who" onClick={() => nav(`/u/${f.handle}`)}>
        <Avatar p={f} size={compact ? 30 : 36} online={online} />
        <span className="col" style={{ gap: 0, minWidth: 0 }}>
          <span className="ellipsis sc-name">{f.name}</span>
          <span className="t-caption ellipsis">{now.room && now.room === myRoom ? 'In your room' : now.room ? 'In a listening room' : now.playing ? 'Listening now' : `Paused · ${relative(now.at)}`}</span>
        </span>
      </button>
      <div className="sc-now-song">
        <span className="sc-now-art"><Artwork src={t.artworkUrl ?? `https://i.ytimg.com/vi/${t.playbackRef}/hqdefault.jpg`} seed={t.artist} />{now.playing && <span className="sc-now-eq"><Eq playing /></span>}</span>
        <span className="col" style={{ gap: 2, minWidth: 0 }}>
          <span className="ellipsis sc-title">{t.title}</span>
          <span className="t-caption ellipsis">{t.artist}</span>
        </span>
      </div>
      <div className="sc-now-bar" aria-hidden><i style={{ transform: `scaleX(${pct})` }} /></div>
      <div className="sc-now-times t-caption tabular"><span>{duration(pos)}</span><span>{duration(t.durationMs)}</span></div>
      <div className="sc-now-actions">
        {now.room && now.room === myRoom
          ? <button className="btn btn-secondary btn-sm" onClick={() => openRoom(now.room!)}><Icon name="radio" size={13} /> Open room</button>
          : following
          ? <button className="btn btn-secondary btn-sm" onClick={() => stopListeningAlong()}><Icon name="stop" size={13} /> Stop</button>
          : <motion.button whileTap={{ scale: 0.95 }} className="btn btn-primary btn-sm" onClick={() => void listenAlong(f.id)}><Icon name="headphones" size={14} /> {now.room ? 'Join room' : 'Listen along'}</motion.button>}
        <button className="icon-btn sm" title="Play this song yourself" aria-label="Play this song" onClick={() => player().play([asTrack(t)], 0, { context: `${f.name} is playing` })}><Icon name="play" size={14} /></button>
        <button className="icon-btn sm" title={`Wave at ${f.name}`} aria-label={`Wave at ${f.name}`} onClick={() => wave(f.id)}><Icon name="waveHand" size={15} /></button>
      </div>
    </motion.article>
  )
}

/** Friends with something playing, most recent first. */
export function useListeningNow(): PersonView[] {
  const friends = useSocial((s) => s.friends)
  const presence = useSocial((s) => s.presence)
  return useMemo(() => friends
    .map((f) => ({ f, now: presence[f.id]?.now ?? f.now, online: presence[f.id]?.online ?? f.online }))
    .filter((x) => x.now?.track && (x.now.playing || Date.now() - x.now.at < 10 * 60_000))
    .sort((a, b) => Number(b.now!.playing) - Number(a.now!.playing) || b.now!.at - a.now!.at)
    .map((x) => ({ ...x.f, now: x.now, online: x.online })), [friends, presence])
}

// ── Send a song to friends ──────────────────────────────────────────────────
export const useSendSheet = create<{ track: Track | null; open: (t: Track) => void; close: () => void }>()((set) => ({
  track: null,
  open: (t) => set({ track: t }),
  close: () => set({ track: null }),
}))

export function SendSheet() {
  const nav = useNavigate()
  const track = useSendSheet((s) => s.track)
  const close = useSendSheet((s) => s.close)
  const friends = useSocial((s) => s.friends)
  const presence = useSocial((s) => s.presence)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  useEffect(() => { if (track) { setPicked(new Set()); setNote(''); setQ('') } }, [track])
  const list = useMemo(() => friends
    .filter((f) => !q.trim() || `${f.name} ${f.handle}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(presence[b.id]?.online ?? b.online) - Number(presence[a.id]?.online ?? a.online) || a.name.localeCompare(b.name)), [friends, presence, q])
  const send = async () => {
    if (!track || !picked.size) return
    setBusy(true)
    try {
      const n = await shareWith([...picked], track, note.trim())
      toast(n === 1 ? `Sent to ${friends.find((f) => picked.has(f.id))?.name}` : `Sent to ${n} friends`)
      close()
    } catch (e) { toast(e instanceof Error ? e.message : 'Couldn’t send') } finally { setBusy(false) }
  }
  return (
    <Sheet open={!!track} onClose={close} title="Send to friends" width={460} className="sc-send">
      {track && (
        <div className="col" style={{ gap: 14 }}>
          <div className="sc-send-track">
            <Artwork src={artworkFor(track)} seed={track.artist} />
            <span className="col" style={{ gap: 2, minWidth: 0 }}><b className="ellipsis">{track.title}</b><span className="t-caption ellipsis">{track.artist}</span></span>
          </div>
          {!hasProfile() || !friends.length ? (
            <div className="sc-empty-mini">
              <Icon name="users" size={22} />
              <div><b>{hasProfile() ? 'No friends yet' : 'Set up Friends first'}</b><div className="t-caption">{hasProfile() ? 'Add friends by their @name or send them your invite link.' : 'Pick a name — it takes a second, no sign-in needed.'}</div></div>
              <button className="btn btn-primary btn-sm" onClick={() => { close(); nav('/friends') }}>Open Friends</button>
            </div>
          ) : (
            <>
              {friends.length > 6 && <input className="field" placeholder="Search friends" value={q} onChange={(e) => setQ(e.target.value)} />}
              <div className="sc-pick">
                {list.map((f) => {
                  const on = picked.has(f.id)
                  return (
                    <motion.button key={f.id} layout whileTap={{ scale: 0.96 }} className={`sc-pick-item ${on ? 'on' : ''}`} aria-pressed={on}
                      onClick={() => { const n = new Set(picked); if (on) n.delete(f.id); else n.add(f.id); setPicked(n) }}>
                      <Avatar p={f} size={46} online={presence[f.id]?.online ?? f.online} />
                      <span className="ellipsis">{f.name.split(' ')[0]}</span>
                      <AnimatePresence>{on && <motion.i className="sc-pick-check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}><Icon name="check" size={12} /></motion.i>}</AnimatePresence>
                    </motion.button>
                  )
                })}
              </div>
              <textarea className="field" rows={2} maxLength={280} placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button className="btn btn-primary btn-lg" disabled={!picked.size || busy} onClick={() => void send()}>
                {busy ? <Spinner size={15} /> : <Icon name="send" size={15} />} {picked.size > 1 ? `Send to ${picked.size} friends` : 'Send'}
              </button>
            </>
          )}
        </div>
      )}
    </Sheet>
  )
}

// ── Invite friends into a listening room ────────────────────────────────────
export function InviteFriends({ code }: { code: string }) {
  const nav = useNavigate()
  const friends = useSocial((s) => s.friends)
  const presence = useSocial((s) => s.presence)
  const [sent, setSent] = useState<Set<string>>(new Set())
  const sorted = useMemo(() => [...friends].sort((a, b) => Number(presence[b.id]?.online ?? b.online) - Number(presence[a.id]?.online ?? a.online)), [friends, presence])
  const invite = async (ids: string[]) => {
    try {
      const n = await inviteToRoom(ids, code)
      setSent(new Set([...sent, ...ids]))
      toast(n > 1 ? `Invited ${n} friends` : `Invited ${friends.find((f) => f.id === ids[0])?.name ?? 'your friend'}`)
    } catch (e) { toast(e instanceof Error ? e.message : 'Couldn’t invite') }
  }
  if (!hasProfile()) {
    return (
      <div className="together-panel glass">
        <div className="t-title">Invite friends</div>
        <div className="t-caption">Add friends once, then invite them here with one tap.</div>
        <button className="btn btn-secondary btn-sm" style={{ marginTop: 10, alignSelf: 'flex-start' }} onClick={() => nav('/friends')}><Icon name="userPlus" size={14} /> Set up Friends</button>
      </div>
    )
  }
  const online = sorted.filter((f) => presence[f.id]?.online ?? f.online)
  return (
    <div className="together-panel glass">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="t-title">Invite friends</div>
        {online.length > 1 && <button className="link t-caption" onClick={() => void invite(online.filter((f) => !sent.has(f.id)).map((f) => f.id))}>Invite everyone online</button>}
      </div>
      {!sorted.length ? <div className="t-caption">No friends yet — <button className="link" onClick={() => nav('/friends')}>add some</button>.</div> : (
        <ul className="sc-invite-list">
          {sorted.slice(0, 12).map((f) => (
            <li key={f.id}>
              <Avatar p={f} size={30} online={presence[f.id]?.online ?? f.online} />
              <span className="grow ellipsis">{f.name}</span>
              <button className={`chip ${sent.has(f.id) ? 'on' : ''}`} disabled={sent.has(f.id)} onClick={() => void invite([f.id])}>{sent.has(f.id) ? <><Icon name="check" size={12} /> Invited</> : 'Invite'}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** "Rohan and 2 others are listening along" — shown on your Now Playing. */
export function ListenersPill() {
  const listeners = useSocial((s) => s.listeners)
  const following = useSocial((s) => s.following)
  const friends = useSocial((s) => s.friends)
  const ref = useRef<HTMLDivElement>(null)
  const followed = friends.find((f) => f.id === following)
  return (
    <AnimatePresence>
      {(listeners.length > 0 || followed) && (
        <motion.div ref={ref} className="sc-listeners glass-thin" initial={{ opacity: 0, y: -6, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6 }}>
          {followed ? (
            <>
              <Avatar p={followed} size={22} />
              <span>Listening along with <b>{followed.name}</b></span>
              <button className="link" onClick={() => stopListeningAlong()}>Stop</button>
            </>
          ) : (
            <>
              <AvatarStack people={listeners} size={22} />
              <span><b>{listeners[0].name}</b>{listeners.length > 1 ? ` and ${listeners.length - 1} more` : ''} listening along</span>
              <Icon name="headphones" size={14} />
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
