import { createPortal } from 'react-dom'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from '../components/Icon'
import { Artwork, Empty, Notice, SkeletonRows, Spinner } from '../components/ui'
import { Avatar, NowCard } from '../components/Social'
import { toast } from '../state/ui'
import { player } from '../state/player'
import { relative } from '../lib/format'
import {
  addFriend, asTrack, blend, block, hasProfile, myTaste, profileLink, profileOf, respond, sharedArtists, SocialError, tasteMatch, unfriend, updateProfile, useSocial,
  type PersonView, type PublicSummary, type SocialTrack,
} from '../services/social'

const COLORS = ['#ff5f6d', '#ffa62b', '#ffd23f', '#3ddc97', '#2ec4b6', '#4cc9f0', '#4361ee', '#7b2ff7', '#f72585', '#b5179e']

export default function ProfilePage() {
  const { handle = '' } = useParams()
  const nav = useNavigate()
  const meId = useSocial((s) => s.me?.id)
  const friendsVersion = useSocial((s) => s.friends)
  const [data, setData] = useState<{ person: PersonView; recent: { at: number; track: SocialTrack }[]; mutual: number; playlists?: PublicSummary[] } | null | 'missing'>(null)
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const load = () => profileOf(handle).then(setData).catch((e) => setData(e instanceof SocialError && e.status === 404 ? 'missing' : null))
  useEffect(() => { if (hasProfile()) void load(); else setData('missing') }, [handle, friendsVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const mine = useMemo(() => myTaste(), [])

  if (!hasProfile()) return <div className="page"><Empty icon="users" title="Set up Friends to see profiles" action={<button className="btn btn-primary" onClick={() => nav('/friends')}>Open Friends</button>} /></div>
  if (data === 'missing') return <div className="page"><Empty icon="user" title="No one here" body={`There’s no @${handle} on Arnav Music yet.`} action={<button className="btn btn-secondary" onClick={() => nav('/friends')}>Back to Friends</button>} /></div>
  if (!data) return <div className="page"><div className="pf-hero skeleton" style={{ height: 260 }} /><SkeletonRows n={6} /></div>

  const p = data.person
  const isMe = p.id === meId
  const match = isMe ? null : tasteMatch(mine, p.taste)
  const shared = isMe ? [] : sharedArtists(mine, p.taste)
  const mix = isMe ? [] : blend(mine, p.taste)
  const top = p.taste?.artists.slice(0, 10) ?? []
  const act = async (fn: () => Promise<unknown>, done?: string) => { try { await fn(); if (done) toast(done); await load() } catch (e) { toast(e instanceof Error ? e.message : 'That didn’t work') } }

  return (
    <div className="page profile" style={{ ['--pc' as string]: p.color }}>
      <section className="pf-hero">
        <div className="pf-hero-glow" aria-hidden />
        <motion.div initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 20 }}>
          <Avatar p={p} size={112} ring online={isMe ? undefined : p.online} />
        </motion.div>
        <div className="pf-id">
          <div className="t-eyebrow">{isMe ? 'Your profile' : p.relation === 'friends' ? 'Friend' : 'Profile'}</div>
          <h1 className="t-hero pf-name">{p.name}</h1>
          <div className="t-sub">@{p.handle}{!isMe && data.mutual > 0 ? ` · ${data.mutual} mutual friend${data.mutual > 1 ? 's' : ''}` : ''}{p.taste?.minutes ? ` · ${p.taste.minutes} min this week` : ''}</div>
          {p.bio && <p className="pf-bio">{p.bio}</p>}
          <div className="pf-actions">
            {isMe ? (
              <>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}><Icon name="edit" size={14} /> Edit profile</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard.writeText(profileLink(p.handle)); toast('Profile link copied') }}><Icon name="link" size={14} /> Copy link</button>
              </>
            ) : p.relation === 'friends' ? (
              <>
                <span className="pf-friends"><Icon name="check" size={14} /> Friends</span>
                {mix.length > 0 && <button className="btn btn-primary btn-sm" onClick={() => player().play(mix, 0, { context: `Blend with ${p.name}` })}><Icon name="shuffle" size={14} /> Play your Blend</button>}
              </>
            ) : p.relation === 'incoming' ? (
              <button className="btn btn-primary btn-sm" onClick={() => void act(() => respond(p.id, true), `You and ${p.name} are friends now 🎉`)}><Icon name="check" size={14} /> Accept request</button>
            ) : p.relation === 'requested' ? (
              <span className="pf-friends muted">Request sent</span>
            ) : p.relation === 'blocked' ? (
              <button className="btn btn-secondary btn-sm" onClick={() => void act(() => unfriend(p.id), 'Unblocked')}>Unblock</button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => void act(async () => { const s = await addFriend({ id: p.id }); toast(s === 'friends' ? `You and ${p.name} are friends now 🎉` : `Request sent to ${p.name}`) })}><Icon name="userPlus" size={14} /> Add friend</button>
            )}
            {!isMe && (
              <div className="fr-privacy">
                <button className="icon-btn" aria-label="More" onClick={() => setMenu(!menu)}><Icon name="more" size={18} /></button>
                <AnimatePresence>
                  {menu && (
                    <motion.div className="fr-privacy-menu glass-thick" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                      <button onClick={() => { setMenu(false); void navigator.clipboard.writeText(profileLink(p.handle)); toast('Profile link copied') }}><b>Copy profile link</b></button>
                      {p.relation === 'friends' && <button onClick={() => { setMenu(false); if (confirm(`Remove ${p.name} from your friends?`)) void act(() => unfriend(p.id), `Removed ${p.name}`) }}><b>Remove friend</b></button>}
                      {p.relation !== 'blocked' && <button className="danger" onClick={() => { setMenu(false); if (confirm(`Block ${p.name}? They won’t be able to add you or send you songs.`)) void act(() => block(p.id), `Blocked ${p.name}`) }}><b>Block</b></button>}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        </div>
        {match != null && (
          <div className="pf-match" title="How alike your top artists are">
            <svg viewBox="0 0 100 100" aria-hidden>
              <circle cx="50" cy="50" r="44" className="pf-match-track" />
              <motion.circle cx="50" cy="50" r="44" className="pf-match-fill" initial={{ pathLength: 0 }} animate={{ pathLength: match / 100 }} transition={{ duration: 1.2, ease: [0.2, 0.8, 0.2, 1] }} />
            </svg>
            <div className="pf-match-n"><b>{match}%</b><span className="t-caption">taste match</span></div>
          </div>
        )}
      </section>

      {!isMe && p.relation !== 'friends' && !p.now && !data.recent.length && <Notice icon="info">Add {p.name.split(' ')[0]} as a friend to see what they listen to.</Notice>}

      {!isMe && p.now?.track && <section className="section"><NowCard f={p} /></section>}

      {shared.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>You both love</h2></div>
          <div className="pf-artists">
            {shared.map((a, i) => (
              <motion.button key={a.name} className="pf-artist" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }} onClick={() => nav(`/artist/${encodeURIComponent(a.name)}`)}>
                <Artwork src={a.artwork} round seed={a.name} icon="user" />
                <span className="ellipsis">{a.name}</span>
              </motion.button>
            ))}
          </div>
        </section>
      )}

      {!isMe && p.relation === 'friends' && !mix.length && (
        <section className="section"><Notice icon="shuffle">Your Blend with {p.name.split(' ')[0]} appears once you’ve both played a few songs — the more you listen, the better it gets.</Notice></section>
      )}

      {mix.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Your Blend</h2>
            <button className="btn btn-secondary btn-sm" onClick={() => player().play(mix, 0, { context: `Blend with ${p.name}` })}><Icon name="play" size={13} /> Play</button>
          </div>
          <div className="t-sub" style={{ marginTop: -6, marginBottom: 10 }}>Songs you both play first, then taking turns between your favourites.</div>
          <div className="pf-blend">
            {mix.slice(0, 12).map((t, i) => (
              <button key={t.id} className="fr-chart-row" onClick={() => player().play(mix, i, { context: `Blend with ${p.name}` })}>
                <span className="fr-feed-art"><Artwork src={t.artworkUrl} seed={t.artist} /></span>
                <span className="grow col" style={{ gap: 1, minWidth: 0, textAlign: 'left' }}><b className="ellipsis">{t.title}</b><span className="t-caption ellipsis">{t.artist}</span></span>
              </button>
            ))}
          </div>
        </section>
      )}

      {top.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>{isMe ? 'Your' : `${p.name.split(' ')[0]}’s`} top artists</h2></div>
          <div className="pf-artists">
            {top.map((a) => (
              <button key={a.name} className="pf-artist" onClick={() => nav(`/artist/${encodeURIComponent(a.name)}`)}>
                <Artwork src={a.artwork} round seed={a.name} icon="user" />
                <span className="ellipsis">{a.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {(data.playlists?.length ?? 0) > 0 && (
        <section className="section">
          <div className="section-head"><h2>{isMe ? 'Your public playlists' : 'Public playlists'}</h2></div>
          <div className="pf-pubs">
            {data.playlists!.map((pl) => (
              <button key={pl.id} className="pf-pub" onClick={() => nav(`/p/${pl.id}`)}>
                <Artwork src={pl.art} seed={pl.title} className="pf-pub-art" />
                <b className="ellipsis">{pl.title}</b>
                <span className="t-caption">{pl.count} songs · {relative(pl.updated)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {data.recent.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Recently played</h2><button className="btn btn-ghost btn-sm" onClick={() => player().play(data.recent.map((r) => asTrack(r.track)), 0, { context: `${p.name}’s recent plays` })}><Icon name="play" size={13} /> Play all</button></div>
          <div className="pf-blend">
            {data.recent.slice(0, 20).map((r, i) => (
              <button key={`${r.at}-${i}`} className="fr-chart-row" onClick={() => player().play(data.recent.map((x) => asTrack(x.track)), i, { context: `${p.name}’s recent plays` })}>
                <span className="fr-feed-art"><Artwork src={r.track.artworkUrl ?? `https://i.ytimg.com/vi/${r.track.playbackRef}/mqdefault.jpg`} seed={r.track.artist} /></span>
                <span className="grow col" style={{ gap: 1, minWidth: 0, textAlign: 'left' }}><b className="ellipsis">{r.track.title}</b><span className="t-caption ellipsis">{r.track.artist}</span></span>
                <span className="t-caption">{relative(r.at)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {createPortal(<AnimatePresence>{editing && isMe && <EditProfile p={p} onClose={() => { setEditing(false); void load() }} onHandle={(h) => nav(`/u/${h}`, { replace: true })} />}</AnimatePresence>, document.body)}
    </div>
  )
}

function EditProfile({ p, onClose, onHandle }: { p: PersonView; onClose: () => void; onHandle: (h: string) => void }) {
  const [name, setName] = useState(p.name)
  const [handle, setHandle] = useState(p.handle)
  const [bio, setBio] = useState(p.bio ?? '')
  const [color, setColor] = useState(p.color)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      await updateProfile({ name: name.trim(), handle: handle.trim().toLowerCase(), bio: bio.trim(), color })
      toast('Profile saved')
      if (handle.trim().toLowerCase() !== p.handle) onHandle(handle.trim().toLowerCase())
      onClose()
    } catch (e) { toast(e instanceof Error ? e.message : 'Couldn’t save') } finally { setBusy(false) }
  }
  return (
    <motion.div className="pf-edit-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.form className="pf-edit glass-thick" initial={{ y: 30, scale: 0.97 }} animate={{ y: 0, scale: 1 }} exit={{ y: 20, opacity: 0 }} transition={{ type: 'spring', stiffness: 360, damping: 30 }}
        onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="row" style={{ justifyContent: 'space-between' }}><div className="t-title">Edit profile</div><button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button></div>
        <div className="row" style={{ gap: 14 }}>
          <Avatar p={{ name, avatar: p.avatar, color }} size={64} ring />
          <div className="pf-colors" role="radiogroup" aria-label="Colour">
            {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} className={color === c ? 'on' : ''} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
          </div>
        </div>
        <label className="pf-field"><span className="t-caption">Name</span><input className="field" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="pf-field"><span className="t-caption">Username</span><div className="pf-handle"><span>@</span><input className="field" maxLength={20} value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, ''))} /></div></label>
        <label className="pf-field"><span className="t-caption">Bio</span><textarea className="field" rows={2} maxLength={160} value={bio} placeholder="What are you listening to lately?" onChange={(e) => setBio(e.target.value)} /></label>
        <button className="btn btn-primary btn-lg" disabled={busy || !name.trim() || handle.length < 3}>{busy ? <Spinner size={15} /> : null} Save</button>
      </motion.form>
    </motion.div>
  )
}
