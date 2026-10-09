import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from '../components/Icon'
import { Artwork, Empty, Eq, Notice, PageHeader, Segmented, SkeletonRows, Spinner } from '../components/ui'
import { Qr } from '../components/PhoneLink'
import { Avatar, AvatarStack, NowCard, useListeningNow } from '../components/Social'
import { toast } from '../state/ui'
import { player } from '../state/player'
import { useAuth } from '../state/auth'
import { relative } from '../lib/format'
import {
  addFriend, asTrack, createProfile, findByCode, findPeople, friendsCharts, friendsFeed, inviteLink, loadInbox, markRead, myTaste,
  openRoom, reactToItem, respond, SocialError, tasteMatch, updateProfile, useSocial, type InboxItem, type Person, type PersonView, type SocialTrack,
} from '../services/social'

type Tab = 'friends' | 'activity' | 'inbox' | 'charts'
const REACTS = ['❤️', '🔥', '😍', '😂', '🕺', '🎶']

export default function FriendsPage() {
  const { code } = useParams()
  const [params, setParams] = useSearchParams()
  const status = useSocial((s) => s.status)
  const me = useSocial((s) => s.me)
  const tab = (params.get('tab') as Tab) || 'friends'
  const setTab = (t: Tab) => setParams(t === 'friends' ? {} : { tab: t }, { replace: true })
  const unread = useSocial((s) => s.unread)
  const incoming = useSocial((s) => s.incoming)

  if (status === 'unavailable') return <div className="page"><PageHeader title="Friends" /><Notice tone="warn">Friends need the Cloudflare-hosted site (Durable Objects). This copy of Arnav Music runs without them.</Notice></div>
  if (status === 'loading' && !me) return <div className="page"><PageHeader title="Friends" /><SkeletonRows n={6} /></div>
  if (!me) return <Setup inviteCode={code ?? null} />

  return (
    <div className="page friends fr-page">
     <div className="fr-layout">
      <header className="fr-head">
        <div className="t-eyebrow">Friends</div>
        <h1 className="t-large">Music is better together.</h1>
        <p className="t-sub">See what your friends play, listen along in one tap, and send each other songs.</p>
      </header>
      <aside className="fr-rail">
        {code && <InviteCard code={code} />}
        <MyCard />
        <AddFriend />
        <Requests />
      </aside>
      <div className="fr-main">
      <ListeningNow />
      <div className="fr-tabs">
        <Segmented id="fr-tab" value={tab} onChange={setTab} options={[
          { value: 'friends', label: <span className="row" style={{ gap: 6 }}>Friends{incoming.length > 0 && <span className="sc-badge">{incoming.length}</span>}</span> },
          { value: 'activity', label: 'Activity' },
          { value: 'inbox', label: <span className="row" style={{ gap: 6 }}>Inbox{unread > 0 && <span className="sc-badge">{unread}</span>}</span> },
          { value: 'charts', label: 'Charts' },
        ]} />
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
          {tab === 'friends' && <FriendsTab />}
          {tab === 'activity' && <ActivityTab />}
          {tab === 'inbox' && <InboxTab />}
          {tab === 'charts' && <ChartsTab />}
        </motion.div>
      </AnimatePresence>
      </div>
     </div>
    </div>
  )
}

// ── First visit: pick a name ────────────────────────────────────────────────
function Setup({ inviteCode }: { inviteCode: string | null }) {
  const user = useAuth((s) => s.user)
  const [name, setName] = useState(user?.displayName ?? '')
  const [busy, setBusy] = useState(false)
  const [inviter, setInviter] = useState<PersonView | null>(null)
  useEffect(() => { if (user?.displayName && !name) setName(user.displayName) }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    setBusy(true)
    try {
      await createProfile(name.trim() || 'Listener')
      if (inviteCode) {
        const who = await findByCode(inviteCode).catch(() => null)
        if (who) { await addFriend({ code: inviteCode }); setInviter(who); toast(`You and ${who.name} are friends now 🎉`) }
      }
    } catch (e) { toast(e instanceof SocialError ? e.message : 'Couldn’t set up Friends — try again') } finally { setBusy(false) }
  }
  return (
    <div className="page friends">
      <section className="fr-hero">
        <div className="fr-hero-art" aria-hidden>
          {['#ff5f6d', '#4cc9f0', '#ffd23f', '#7b2ff7', '#3ddc97'].map((c, i) => (
            <motion.span key={c} style={{ ['--c' as string]: c }} initial={{ opacity: 0, scale: 0.6, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ delay: 0.08 * i, type: 'spring', stiffness: 220, damping: 18 }} />
          ))}
        </div>
        <div className="t-eyebrow">Friends</div>
        <h1 className="t-hero">Music is better<br />together.</h1>
        <p className="t-sub fr-hero-sub">See what your friends are listening to right now, listen along in one tap, share songs, and find out how alike your taste is.</p>
        {inviteCode && <Notice icon="userPlus">You were invited — pick a name and you’ll be friends straight away.</Notice>}
        <form className="fr-setup" onSubmit={(e) => { e.preventDefault(); void go() }}>
          <input className="field" autoFocus maxLength={40} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" />
          <button className="btn btn-primary btn-lg" disabled={busy || !name.trim()}>{busy ? <Spinner size={16} /> : <Icon name="sparkles" size={16} />} Get started</button>
        </form>
        <div className="t-caption fr-hero-note">{user ? 'Linked to your account, so it’s on all your devices.' : 'No sign-in needed. Sign in later to keep your friends on every device.'} Only friends see what you play — and you can go private any time.</div>
        {inviter && <div className="t-caption">Added {inviter.name}.</div>}
      </section>
    </div>
  )
}

function InviteCard({ code }: { code: string }) {
  const nav = useNavigate()
  const me = useSocial((s) => s.me)
  const friendIds = useSocial((s) => s.friends.map((f) => f.id).join())
  const [who, setWho] = useState<PersonView | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  useEffect(() => { void findByCode(code).then(setWho).catch(() => setWho(null)) }, [code])
  if (who === undefined) return <div className="fr-invite glass"><Spinner size={18} /></div>
  if (!who) return <Notice tone="warn">That invite link isn’t valid any more.</Notice>
  if (who.id === me?.id) return <Notice icon="link">That’s your own invite link — send it to a friend.</Notice>
  const done = who.relation === 'friends' || friendIds.split(',').includes(who.id)
  return (
    <motion.div className="fr-invite glass" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <Avatar p={who} size={56} ring />
      <div className="grow col" style={{ gap: 2 }}>
        <div className="t-title">{done ? `You and ${who.name} are friends` : `${who.name} invited you`}</div>
        <div className="t-caption">@{who.handle}</div>
      </div>
      {done
        ? <button className="btn btn-secondary btn-sm" onClick={() => nav(`/u/${who.handle}`, { replace: true })}>View profile</button>
        : <button className="btn btn-primary btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { await addFriend({ code }); toast(`You and ${who.name} are friends now 🎉`); nav(`/u/${who.handle}`, { replace: true }) } catch (e) { toast(e instanceof Error ? e.message : 'Couldn’t add') } finally { setBusy(false) } }}><Icon name="userPlus" size={14} /> Add friend</button>}
    </motion.div>
  )
}

// ── You ─────────────────────────────────────────────────────────────────────
function MyCard() {
  const nav = useNavigate()
  const me = useSocial((s) => s.me)!
  const connected = useSocial((s) => s.connected)
  const friends = useSocial((s) => s.friends.length)
  const live = useListeningNow().filter((f) => f.now?.playing).length
  const [qr, setQr] = useState(false)
  const link = inviteLink(me.code)
  const share = async () => {
    const text = 'Add me on Arnav Music — let’s listen together 🎧'
    if (navigator.share) await navigator.share({ title: 'Arnav Music', text, url: link }).catch(() => undefined)
    else { await navigator.clipboard.writeText(link).catch(() => undefined); toast('Invite link copied') }
  }
  return (
    <section className="fr-me glass" style={{ ['--c' as string]: me.color }}>
      <div className="fr-me-glow" aria-hidden />
      <button className="fr-me-id" onClick={() => nav(`/u/${me.handle}`)} aria-label="Your profile">
        <Avatar p={me} size={56} ring />
        <span className="col" style={{ gap: 2, minWidth: 0 }}>
          <span className="fr-me-name ellipsis">{me.name}</span>
          <span className="t-caption ellipsis">@{me.handle}</span>
        </span>
        <span className={`fr-live ${connected ? 'on' : ''}`}><i />{connected ? 'Live' : 'Connecting'}</span>
      </button>
      <div className="fr-stats">
        <div><b>{friends}</b><span>friend{friends === 1 ? '' : 's'}</span></div>
        <div><b>{live}</b><span>listening now</span></div>
      </div>
      <div className="fr-me-actions">
        <button className="btn btn-primary" onClick={() => void share()}><Icon name="userPlus" size={15} /> Invite friends</button>
        <button className={`icon-btn fr-qr-btn ${qr ? 'on' : ''}`} aria-label="Show QR code" aria-pressed={qr} onClick={() => setQr(!qr)}><Icon name="grid" size={17} /></button>
        <button className="icon-btn fr-qr-btn" aria-label="Copy invite link" onClick={() => { void navigator.clipboard.writeText(link); toast('Invite link copied') }}><Icon name="link" size={17} /></button>
      </div>
      <AnimatePresence initial={false}>
        {qr && (
          <motion.div className="fr-qr" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 320, damping: 32 }}>
            <div className="fr-qr-inner">
              <div className="fr-qr-code"><Qr text={link} /></div>
              <div className="col" style={{ gap: 4, minWidth: 0 }}>
                <b>Scan to add {me.name.split(' ')[0]}</b>
                <span className="t-caption">Whoever opens it becomes your friend.</span>
                <code className="fr-link ellipsis">{link.replace(/^https?:\/\//, '')}</code>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <PrivacyPicker />
    </section>
  )
}

/** Who sees what you play — three clear choices, always visible. */
function PrivacyPicker() {
  const privacy = useSocial((s) => s.me?.privacy ?? 'friends')
  const pick = async (p: 'everyone' | 'friends' | 'off') => {
    if (p === privacy) return
    try { await updateProfile({ privacy: p }); toast(p === 'off' ? 'Private session — friends won’t see what you play' : p === 'everyone' ? 'Anyone with your profile sees what you play' : 'Only friends see what you play') } catch { toast('Couldn’t change that') }
  }
  return (
    <div className="fr-privacy">
      <div className="t-caption">Who sees what you play</div>
      <Segmented id="fr-privacy" size="sm" value={privacy} onChange={(v) => void pick(v)} options={[
        { value: 'friends', label: 'Friends' },
        { value: 'everyone', label: 'Everyone' },
        { value: 'off', label: <span className="row" style={{ gap: 5 }}><Icon name="moon" size={12} /> Private</span> },
      ]} />
    </div>
  )
}

function Requests() {
  const nav = useNavigate()
  const incoming = useSocial((s) => s.incoming)
  const outgoing = useSocial((s) => s.outgoing)
  if (!incoming.length && !outgoing.length) return null
  return (
    <section className="fr-panel glass">
      <div className="fr-panel-head"><span className="t-title">Requests</span>{incoming.length > 0 && <span className="sc-badge">{incoming.length}</span>}</div>
      <AnimatePresence initial={false}>
        {incoming.map((p) => (
          <motion.div key={p.id} layout className="fr-req" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
            <button className="fr-row-who" onClick={() => nav(`/u/${p.handle}`)}><Avatar p={p} size={38} /><span className="col" style={{ gap: 0, minWidth: 0 }}><b className="ellipsis">{p.name}</b><span className="t-caption ellipsis">@{p.handle}</span></span></button>
            <button className="btn btn-primary btn-sm" onClick={() => void respond(p.id, true).then(() => toast(`You and ${p.name} are friends now 🎉`))}>Accept</button>
            <button className="icon-btn sm" aria-label={`Decline ${p.name}`} onClick={() => void respond(p.id, false)}><Icon name="close" size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
      {outgoing.length > 0 && (
        <div className="fr-sent">
          <span className="t-caption">Waiting for</span>
          <div className="fr-chips">{outgoing.map((p) => <button key={p.id} className="chip" onClick={() => nav(`/u/${p.handle}`)}><Avatar p={p} size={20} /> {p.name.split(' ')[0]}</button>)}</div>
        </div>
      )}
    </section>
  )
}

function ListeningNow() {
  const live = useListeningNow()
  const friends = useSocial((s) => s.friends.length)
  if (!friends) return null
  return (
    <section className="fr-section">
      <div className="section-head"><h2>Listening now</h2>{live.length > 0 && <span className="t-caption">{live.filter((f) => f.now?.playing).length} playing</span>}</div>
      {live.length ? (
        <div className="fr-now-row">
          <AnimatePresence initial={false}>{live.map((f) => <NowCard key={f.id} f={f} />)}</AnimatePresence>
        </div>
      ) : (
        <div className="fr-quiet glass"><span className="fr-quiet-eq" aria-hidden><i /><i /><i /><i /></span><span className="t-sub">No one’s playing right now — they’ll show up here the moment they press play.</span></div>
      )}
    </section>
  )
}

// ── Friends ─────────────────────────────────────────────────────────────────
function FriendsTab() {
  const nav = useNavigate()
  const friends = useSocial((s) => s.friends)
  const presence = useSocial((s) => s.presence)
  const me = useSocial((s) => s.me)
  const mine = useMemo(() => myTaste(), [])
  const sorted = useMemo(() => [...friends].sort((a, b) => Number(presence[b.id]?.online ?? b.online) - Number(presence[a.id]?.online ?? a.online) || (b.seen ?? 0) - (a.seen ?? 0)), [friends, presence])
  if (!friends.length) {
    const link = me ? inviteLink(me.code) : ''
    return (
      <div className="fr-empty glass">
        <div className="fr-empty-art" aria-hidden>{['#ff5f6d', '#4cc9f0', '#ffd23f'].map((c) => <span key={c} style={{ ['--c' as string]: c }} />)}</div>
        <div className="t-title">Bring your friends</div>
        <p className="t-sub">Send your invite link — whoever opens it is added straight away. Or find someone by their @name.</p>
        <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => { if (navigator.share) void navigator.share({ title: 'Arnav Music', url: link }).catch(() => undefined); else { void navigator.clipboard.writeText(link); toast('Invite link copied') } }}><Icon name="share" size={15} /> Share invite link</button>
        </div>
      </div>
    )
  }
  return (
    <div className="fr-grid">
      {sorted.map((f, i) => {
        const online = presence[f.id]?.online ?? f.online
        const now = presence[f.id]?.now ?? f.now
        const match = tasteMatch(mine, f.taste)
        const playing = !!now?.track && now.playing
        return (
          <motion.button key={f.id} layout className={`fr-card glass ${playing ? 'playing' : ''}`} onClick={() => nav(`/u/${f.handle}`)}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.025 }} style={{ ['--c' as string]: f.color }}>
            <Avatar p={f} size={48} online={online} />
            <span className="fr-card-text">
              <b className="ellipsis">{f.name}</b>
              <span className="t-caption ellipsis">
                {playing ? <><Eq playing /> {now!.track!.title}</> : online ? 'Online' : f.seen ? `Active ${relative(f.seen)}` : `@${f.handle}`}
              </span>
            </span>
            {match != null
              ? <span className="fr-match" title="Taste match" style={{ ['--m' as string]: match / 100 }}><span>{match}%</span></span>
              : <Icon name="chevronRight" size={16} className="subtle" />}
          </motion.button>
        )
      })}
    </div>
  )
}

function AddFriend() {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<PersonView[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  useEffect(() => {
    const term = q.trim()
    if (term.replace(/^@/, '').length < 2) { setResults(null); return }
    setBusy(true)
    const t = setTimeout(() => { void findPeople(term).then(setResults).catch(() => setResults([])).finally(() => setBusy(false)) }, 280)
    return () => clearTimeout(t)
  }, [q])
  const add = async (p: PersonView) => {
    setAdding(p.id)
    try {
      const state = await addFriend({ id: p.id })
      toast(state === 'friends' ? `You and ${p.name} are friends now 🎉` : `Request sent to ${p.name}`)
      setResults((r) => r?.map((x) => (x.id === p.id ? { ...x, relation: state === 'friends' ? 'friends' : 'requested' } : x)) ?? null)
    } catch (e) { toast(e instanceof Error ? e.message : 'Couldn’t add') } finally { setAdding(null) }
  }
  return (
    <section className="fr-add">
      <div className="fr-search glass">
        <Icon name="userPlus" size={18} />
        <input placeholder="Add a friend by @name or name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find people" autoComplete="off" spellCheck={false} />
        {busy && <Spinner size={15} />}
      </div>
      <AnimatePresence>
        {results && (
          <motion.div className="fr-results glass" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            {!results.length ? <div className="t-caption" style={{ padding: 14 }}>No one by that name yet — send them your invite link instead.</div> : results.map((p) => (
              <div key={p.id} className="fr-result">
                <button className="fr-row-who" onClick={() => nav(`/u/${p.handle}`)}><Avatar p={p} size={36} /><span className="col" style={{ gap: 0, minWidth: 0 }}><b className="ellipsis">{p.name}</b><span className="t-caption">@{p.handle}</span></span></button>
                {p.relation === 'friends' ? <span className="t-caption"><Icon name="check" size={12} /> Friends</span>
                  : p.relation === 'requested' ? <span className="t-caption">Requested</span>
                  : p.relation === 'incoming' ? <button className="btn btn-primary btn-sm" onClick={() => void respond(p.id, true).then(() => setResults((r) => r?.map((x) => (x.id === p.id ? { ...x, relation: 'friends' } : x)) ?? null))}>Accept</button>
                  : <button className="btn btn-secondary btn-sm" disabled={adding === p.id} onClick={() => void add(p)}>{adding === p.id ? <Spinner size={13} /> : <Icon name="plus" size={13} />} Add</button>}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

// ── Activity ────────────────────────────────────────────────────────────────
function ActivityTab() {
  const nav = useNavigate()
  const [items, setItems] = useState<{ who: Person; at: number; track: SocialTrack }[] | null>(null)
  useEffect(() => { void friendsFeed().then(setItems).catch(() => setItems([])) }, [])
  if (!items) return <SkeletonRows n={6} />
  if (!items.length) return <Empty icon="history" title="Nothing yet" body="When your friends play music, it shows up here." />
  const groups = new Map<string, typeof items>()
  for (const it of items) {
    const d = new Date(it.at)
    const today = new Date()
    const key = d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === new Date(Date.now() - 86_400_000).toDateString() ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long' })
    groups.set(key, [...(groups.get(key) ?? []), it])
  }
  return (
    <div className="col" style={{ gap: 20 }}>
      {[...groups].map(([day, list]) => (
        <section key={day}>
          <div className="t-eyebrow" style={{ marginBottom: 8 }}>{day}</div>
          <div className="fr-feed">
            {list.map((it, i) => (
              <motion.div key={`${it.at}-${i}`} className="fr-feed-item" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.02 }}>
                <button onClick={() => nav(`/u/${it.who.handle}`)} aria-label={it.who.name}><Avatar p={it.who} size={34} /></button>
                <button className="fr-feed-song" onClick={() => { const t = asTrack(it.track); player().play([t], 0, { context: `${it.who.name} played` }) }}>
                  <span className="fr-feed-art"><Artwork src={it.track.artworkUrl ?? `https://i.ytimg.com/vi/${it.track.playbackRef}/mqdefault.jpg`} seed={it.track.artist} /><span className="fr-feed-play"><Icon name="play" size={14} /></span></span>
                  <span className="col" style={{ gap: 1, minWidth: 0, textAlign: 'left' }}>
                    <span className="t-caption"><b>{it.who.name.split(' ')[0]}</b> played · {relative(it.at)}</span>
                    <span className="ellipsis fr-feed-title">{it.track.title}</span>
                    <span className="t-caption ellipsis">{it.track.artist}</span>
                  </span>
                </button>
              </motion.div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

// ── Inbox ───────────────────────────────────────────────────────────────────
function InboxTab() {
  const nav = useNavigate()
  const inbox = useSocial((s) => s.inbox)
  const sent = useSocial((s) => s.sent)
  const [view, setView] = useState<'got' | 'sent'>('got')
  useEffect(() => { void loadInbox().then(() => markRead()).catch(() => undefined) }, [])
  if (!inbox) return <SkeletonRows n={5} />
  const list = view === 'got' ? inbox : sent
  return (
    <div className="col" style={{ gap: 14 }}>
      <Segmented id="fr-inbox" size="sm" value={view} onChange={setView} options={[{ value: 'got', label: 'Received' }, { value: 'sent', label: 'Sent' }]} />
      {!list.length ? (
        <Empty icon="inbox" title={view === 'got' ? 'No songs yet' : 'You haven’t sent anything'} body={view === 'got' ? 'When friends send you songs or invite you to listen, they land here.' : 'Open any song’s menu and choose “Send to friends”.'} />
      ) : (
        <div className="fr-inbox">
          {list.map((it) => <InboxCard key={`${view}-${it.n}`} it={it} onOpen={(h) => nav(`/u/${h}`)} />)}
        </div>
      )}
    </div>
  )
}

function InboxCard({ it, onOpen }: { it: InboxItem; onOpen: (handle: string) => void }) {
  const who = it.mine ? it.to : it.from
  const t = it.body.track
  return (
    <motion.article layout className={`fr-msg glass ${it.read || it.mine ? '' : 'unread'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="fr-msg-head">
        {who && <button onClick={() => onOpen(who.handle)}><Avatar p={who} size={30} /></button>}
        <span className="t-caption grow">{it.mine ? <>To <b>{who?.name ?? 'a friend'}</b></> : <><b>{who?.name ?? 'A friend'}</b> {it.kind === 'invite' ? 'invited you to listen together' : 'sent you a song'}</>} · {relative(it.at)}</span>
        {it.reaction && <span className="fr-msg-reaction">{it.reaction}</span>}
      </div>
      {it.body.note && <p className="fr-msg-note">“{it.body.note}”</p>}
      {t && (
        <button className="fr-msg-song" onClick={() => { const tr = asTrack(t); player().play([tr], 0, { context: it.mine ? 'Sent to a friend' : `From ${who?.name ?? 'a friend'}` }) }}>
          <span className="fr-feed-art"><Artwork src={t.artworkUrl ?? `https://i.ytimg.com/vi/${t.playbackRef}/mqdefault.jpg`} seed={t.artist} /><span className="fr-feed-play"><Icon name="play" size={14} /></span></span>
          <span className="col" style={{ gap: 1, minWidth: 0, textAlign: 'left' }}><b className="ellipsis">{t.title}</b><span className="t-caption ellipsis">{t.artist}</span></span>
        </button>
      )}
      <div className="fr-msg-actions">
        {it.kind === 'invite' && it.body.room && !it.mine && <button className="btn btn-primary btn-sm" onClick={() => openRoom(it.body.room!)}><Icon name="radio" size={14} /> Join {it.body.room}</button>}
        {!it.mine && (
          <div className="fr-react-row" role="group" aria-label="React">
            {REACTS.map((e) => <motion.button key={e} whileTap={{ scale: 0.75 }} whileHover={{ y: -2 }} className={it.reaction === e ? 'on' : ''} onClick={() => void reactToItem(it.n, it.reaction === e ? null : e)} aria-label={`React ${e}`}>{e}</motion.button>)}
          </div>
        )}
      </div>
    </motion.article>
  )
}

// ── Charts ──────────────────────────────────────────────────────────────────
function ChartsTab() {
  const [data, setData] = useState<{ items: { track: SocialTrack; plays: number; listeners: Person[] }[]; people: number } | null>(null)
  useEffect(() => { void friendsCharts().then(setData).catch(() => setData({ items: [], people: 0 })) }, [])
  if (!data) return <SkeletonRows n={8} />
  if (!data.items.length) return <Empty icon="chart" title="No chart yet" body="The songs you and your friends play most this week rank here." />
  const tracks = data.items.map((x) => asTrack(x.track))
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span className="t-sub">Most played by you and {data.people - 1} friend{data.people === 2 ? '' : 's'} this week</span>
        <button className="btn btn-primary btn-sm" onClick={() => player().play(tracks, 0, { context: 'Friends chart' })}><Icon name="play" size={14} /> Play all</button>
      </div>
      <ol className="fr-chart">
        {data.items.map((x, i) => (
          <motion.li key={x.track.playbackRef} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 15) * 0.025 }}>
            <button className="fr-chart-row" onClick={() => player().play(tracks, i, { context: 'Friends chart' })}>
              <span className={`fr-rank ${i < 3 ? 'top' : ''}`}>{i + 1}</span>
              <span className="fr-feed-art"><Artwork src={x.track.artworkUrl ?? `https://i.ytimg.com/vi/${x.track.playbackRef}/mqdefault.jpg`} seed={x.track.artist} /></span>
              <span className="grow col" style={{ gap: 1, minWidth: 0, textAlign: 'left' }}><b className="ellipsis">{x.track.title}</b><span className="t-caption ellipsis">{x.track.artist}</span></span>
              <AvatarStack people={x.listeners} size={22} />
              <span className="t-caption tabular fr-plays">{x.plays}×</span>
            </button>
          </motion.li>
        ))}
      </ol>
    </div>
  )
}
