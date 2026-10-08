import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from '../components/Icon'
import { Artwork, Notice, PageHeader, Spinner } from '../components/ui'
import { Qr } from '../components/PhoneLink'
import { ArtistLinks } from '../components/TrackRow'
import { usePlayer } from '../state/player'
import { toast } from '../state/ui'
import { artworkFor } from '../lib/classify'
import { dismissSuggestion, joinRoom, leaveRoom, listenerName, makeHost, newRoomCode, react, REACTIONS, resync, roomLink, setListenerName, toTrack, useTogether, validCode } from '../services/together'
import { player } from '../state/player'

/** Listen together: start or join a room; everyone hears the host's music at the same moment. */
export default function TogetherPage() {
  const { code: param } = useParams()
  const nav = useNavigate()
  const { code, status, error, members, hostId, you, following, room, suggestions } = useTogether()
  const track = usePlayer((s) => s.queue[s.index]?.track ?? null)
  const playingHere = usePlayer((s) => s.isPlaying)
  const [joinCode, setJoinCode] = useState('')
  const [name, setName] = useState(listenerName)

  // Opening a room link joins it.
  useEffect(() => {
    const c = param?.toUpperCase()
    if (c && validCode(c) && c !== useTogether.getState().code) joinRoom(c)
  }, [param])

  const start = () => { const c = newRoomCode(); nav(`/together/${c}`, { replace: true }); joinRoom(c) }
  const host = !!you && you === hostId
  const shown = host ? track : room?.track ? toTrack(room.track) : track
  const copy = async () => {
    if (!code) return
    const link = roomLink(code)
    if (navigator.share) await navigator.share({ title: 'Listen with me on Arnav Music', url: link }).catch(() => undefined)
    else { await navigator.clipboard.writeText(link).catch(() => undefined); toast('Room link copied') }
  }

  if (!code) {
    return (
      <div className="page together">
        <PageHeader eyebrow="Listen together" title="Same song, same second." subtitle="Start a room and share the link. Everyone hears your music in sync, and reactions fly across every screen." />
        <section className="section together-start">
          <div className="together-card glass">
            <div className="together-glyph"><Icon name="radio" size={30} /></div>
            <div className="t-title">Start a room</div>
            <div className="t-sub">You host: what you play, everyone plays.</div>
            <label className="together-name">
              <span className="t-caption">Your name in the room</span>
              <input className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={() => setListenerName(name.trim() || 'Listener')} />
            </label>
            <button className="btn btn-primary btn-lg" onClick={() => { setListenerName(name.trim() || 'Listener'); start() }}><Icon name="play" size={16} /> Start a room</button>
          </div>
          <div className="together-card glass">
            <div className="together-glyph alt"><Icon name="link" size={28} /></div>
            <div className="t-title">Join a room</div>
            <div className="t-sub">Enter the 6-character code from a friend.</div>
            <form className="together-join" onSubmit={(e) => { e.preventDefault(); const c = joinCode.toUpperCase(); if (validCode(c)) { setListenerName(name.trim() || 'Listener'); nav(`/together/${c}`) } else toast('Codes are 6 letters and numbers') }}>
              <input className="field code" value={joinCode} maxLength={6} inputMode="text" autoCapitalize="characters" placeholder="ABC234" aria-label="Room code" onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
              <button className="btn btn-secondary btn-lg" type="submit" disabled={joinCode.length !== 6}>Join</button>
            </form>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="page together">
      <PageHeader
        eyebrow={<span className="together-live"><i /> {status === 'live' ? 'Live room' : status === 'error' ? 'Disconnected' : 'Connecting…'}</span>}
        title={<span className="together-code">{code}</span>}
        subtitle={host ? 'You’re the host — everyone hears what you play.' : `Following ${members.find((m) => m.id === hostId)?.name ?? 'the host'}.`}
        actions={<><button className="btn btn-secondary btn-sm" onClick={() => void copy()}><Icon name="share" size={14} /> Invite</button><button className="btn btn-ghost btn-sm" onClick={() => { leaveRoom(); nav('/together') }}>Leave</button></>}
      />
      {error && <Notice tone="warn">{error}</Notice>}
      {!host && room?.playing && (!playingHere || !following) && (
        <motion.button className="together-join-music" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} onClick={resync}>
          <span className="together-join-icon"><Icon name="play" size={18} /></span>
          <span><b>Join the music</b><span className="t-caption">{following ? 'Your browser needs one tap to play sound.' : 'You’re steering your own music — tap to follow the room again.'}</span></span>
        </motion.button>
      )}
      <section className="section together-grid">
        <div className="together-now glass">
          {status !== 'live' && !shown ? <div className="center" style={{ minHeight: 220 }}><Spinner size={24} /></div> : shown ? (
            <>
              <div className="together-art"><Artwork src={artworkFor(shown)} seed={shown.artist} hi /></div>
              <div className="together-meta">
                <div className="t-eyebrow">Now playing in the room</div>
                <div className="together-title ellipsis">{shown.title}</div>
                <div className="t-sub ellipsis"><ArtistLinks track={shown} /></div>
                {!host && room && room.upNext.length > 0 && <div className="t-caption ellipsis" style={{ marginTop: 6 }}>Up next: {room.upNext[0].title}</div>}
                <div className="row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary btn-sm" onClick={() => player().setExpanded(true)}><Icon name="expand" size={14} /> Now Playing</button>
                  {host && <button className="btn btn-secondary btn-sm" onClick={() => nav('/explore')}><Icon name="search" size={14} /> Pick music</button>}
                </div>
              </div>
            </>
          ) : (
            <div className="together-empty"><div className="t-title">Nothing playing yet</div><div className="t-sub">{host ? 'Play any song — the room follows.' : 'The host hasn’t started a song.'}</div></div>
          )}
          <div className="together-reacts" role="group" aria-label="React">
            {REACTIONS.map((e) => <motion.button key={e} whileTap={{ scale: 0.8 }} whileHover={{ y: -3 }} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</motion.button>)}
          </div>
        </div>
        <aside className="together-side">
          <div className="together-panel glass">
            <div className="row" style={{ justifyContent: 'space-between' }}><div className="t-title">In the room</div><span className="t-caption">{members.length}</span></div>
            <ul className="together-members">
              <AnimatePresence initial={false}>
                {members.map((m) => (
                  <motion.li key={m.id} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }}>
                    <span className="together-avatar" style={{ ['--h' as string]: (m.name.charCodeAt(0) * 37) % 360 }}>{m.name.slice(0, 1).toUpperCase()}</span>
                    <span className="grow ellipsis">{m.name}{m.id === you ? ' (you)' : ''}</span>
                    {m.id === hostId ? <span className="badge">Host</span> : host ? <button className="link t-caption" onClick={() => makeHost(m.id)}>Make host</button> : null}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </div>
          <div className="together-panel glass together-invite">
            <Qr text={roomLink(code)} />
            <div>
              <div className="t-title">Invite</div>
              <div className="t-caption">Scan, or share the link. Anyone with it can listen.</div>
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={() => void copy()}><Icon name="link" size={14} /> Copy link</button>
            </div>
          </div>
          {host && suggestions.length > 0 && (
            <div className="together-panel glass">
              <div className="t-title">Suggestions</div>
              {suggestions.map((s) => (
                <div key={s.key} className="together-sugg">
                  <span className="grow ellipsis"><b>{s.track.title}</b><span className="t-caption"> · from {s.name}</span></span>
                  <button className="chip" onClick={() => { player().playNext([s.track]); dismissSuggestion(s.key) }}>Play next</button>
                  <button className="icon-btn sm" aria-label="Dismiss" onClick={() => dismissSuggestion(s.key)}><Icon name="close" size={13} /></button>
                </div>
              ))}
            </div>
          )}
        </aside>
      </section>
    </div>
  )
}
