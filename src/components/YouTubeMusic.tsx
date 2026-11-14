import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Icon } from './Icon'
import { Artwork, Notice, Sheet, Spinner, Toggle } from './ui'
import { relative } from '../lib/format'
import type { FirstLink, SyncMode } from '../lib/ytsync'
import { useLibrary, visiblePlaylists } from '../state/library'
import { toast } from '../state/ui'
import {
  addToYouTube, connect, disconnect, exportLinks, hasPass, importedYtId, link, MAX_PINS, moveImportedLikes, pinToYouTube, reconnect, setMode, syncNow, unitsLeft, unlink, unpin, useYtMusic, type YtLink,
} from '../services/youtubeMusic'
import { findDuplicates } from '../services/importer'
import { trackRegistry } from '../state/tracks'

const MODES: { value: SyncMode; label: string }[] = [
  { value: 'two-way', label: 'Both ways' },
  { value: 'from-youtube', label: 'From YouTube Music' },
  { value: 'to-youtube', label: 'To YouTube Music' },
]
export const ytMusicUrl = (ytId: string) => `https://music.youtube.com/playlist?list=${ytId}`

/** One line saying where sync stands, with the action it needs (if any). */
export function YtStatusLine({ compact = false }: { compact?: boolean }) {
  const { status, lastSyncAt, message, connected } = useYtMusic()
  if (!connected) return null
  const text =
    status === 'syncing' ? 'Syncing with YouTube Music…'
      : status === 'needs-pass' ? 'Paused — Google’s pass lasts an hour. Reconnect to sync what’s waiting.'
        : status === 'quota' ? 'YouTube’s daily limit is reached — the rest syncs tomorrow.'
          : status === 'error' ? (message ?? 'Sync hit a problem.')
            : lastSyncAt ? `In sync · ${relative(lastSyncAt)}` : 'Connected'
  return (
    <div className={`yt-status ${status}`} role="status">
      <span className={`yt-dot ${status}`} aria-hidden>{status === 'syncing' ? <Icon name="sync" size={13} /> : null}</span>
      <span className="grow">{text}</span>
      {status === 'needs-pass' && <button className="btn btn-primary btn-sm" onClick={() => void reconnect()}>Reconnect</button>}
      {!compact && (status === 'idle' || status === 'error') && hasPass() && <button className="btn btn-ghost btn-sm" onClick={() => void syncNow()}><Icon name="sync" size={14} /> Sync now</button>}
    </div>
  )
}

/** Settings → YouTube Music. */
export function YouTubeMusicSettings() {
  const nav = useNavigate()
  const s = useYtMusic()
  const playlists = useLibrary((x) => x.playlists)
  const [busy, setBusy] = useState(false)
  const links = Object.values(s.links)
  const editsLeft = Math.max(0, Math.floor(unitsLeft() / 50))
  if (!s.connected) {
    return (
      <div className="col" style={{ gap: 14 }}>
        <div className="yt-hero glass">
          <div className="yt-hero-icons" aria-hidden><span className="yt-badge big"><Icon name="youtube" size={22} /></span><Icon name="sync" size={18} /><span className="yt-badge big arnav"><Icon name="note" size={20} /></span></div>
          <div className="t-title">Keep YouTube Music and Arnav in sync</div>
          <p className="t-sub">Linked playlists and your likes stay the same in both: add, remove or reorder songs in either app and the other follows — and your phone too.</p>
          <ul className="yt-points t-sub">
            <li><Icon name="check" size={14} /> Changes on both sides are merged; nothing one side didn’t delete is removed.</li>
            <li><Icon name="check" size={14} /> Syncs while Arnav is open. Google’s pass lasts an hour; then it’s one tap to continue.</li>
            <li><Icon name="check" size={14} /> Arnav asks to manage your YouTube playlists and likes — nothing else. Disconnect any time.</li>
          </ul>
          {s.message && <Notice tone="error">{s.message}</Notice>}
          <button className="btn btn-primary btn-lg" disabled={busy} onClick={async () => { setBusy(true); await connect(); setBusy(false) }}>{busy ? <Spinner /> : <Icon name="youtube" size={18} />} Connect YouTube Music</button>
        </div>
      </div>
    )
  }
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="yt-card glass">
        <div className="row" style={{ gap: 12 }}>
          <span className="yt-badge"><Icon name="youtube" size={18} /></span>
          <div className="grow col" style={{ gap: 0, minWidth: 0 }}>
            <b className="ellipsis">YouTube Music</b>
            <span className="t-caption ellipsis">{s.account ?? 'Your Google account'}</span>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={async () => { setBusy(true); if (!hasPass()) await reconnect(); else await connect(); setBusy(false) }} disabled={busy}>Choose playlists</button>
        </div>
        <YtStatusLine />
        <div className="yt-quota" aria-label={`About ${editsLeft} YouTube edits left today`}>
          <div className="yt-quota-bar"><i style={{ width: `${Math.min(100, (unitsLeft() / 9000) * 100)}%` }} /></div>
          <span className="t-caption">About {editsLeft} edits left today · YouTube allows a limited number a day, shared by Arnav</span>
        </div>
      </div>

      <div className="set-group"><div className="set-card">
        <div className="set-row"><div className="grow"><div className="set-title">Liked Songs</div><div className="t-caption set-sub">Your likes here and YouTube Music’s Liked Songs stay the same (songs only — not other videos you liked).</div></div><Toggle on={s.likesSync} label="Sync Liked Songs" onChange={(v) => { useYtMusic.setState({ likesSync: v }); if (v) void syncNow() }} /></div>
        <div className="set-row"><div className="grow"><div className="set-title">Followed artists</div><div className="t-caption set-sub">Following an artist here subscribes to their channel on YouTube, and artists you subscribe to there are followed here. Other channels are never touched.</div></div><Toggle on={s.subsSync} label="Sync followed artists with YouTube subscriptions" onChange={(v) => { useYtMusic.setState({ subsSync: v }); if (v) void syncNow() }} /></div>
        <div className="set-row"><div className="grow"><div className="set-title">New YouTube Music playlists</div><div className="t-caption set-sub">Playlists you create there appear here and stay linked.</div></div><Toggle on={s.autoLinkNew} label="Link new playlists" onChange={(v) => useYtMusic.setState({ autoLinkNew: v })} /></div>
      </div></div>

      <div>
        <h3 className="t-eyebrow" style={{ margin: '6px 0 10px' }}>Linked playlists · {links.length}</h3>
        {links.length === 0 ? <div className="t-sub">None yet — Choose playlists to link them.</div> : (
          <div className="yt-links">
            {links.map((l) => <LinkRow key={l.arnavId} l={l} name={playlists[l.arnavId]?.name ?? l.title} open={() => nav(`/playlist/${l.arnavId}`)} />)}
          </div>
        )}
      </div>

      <LibraryHealth />

      {s.log.length > 0 && (
        <div>
          <h3 className="t-eyebrow" style={{ margin: '6px 0 10px' }}>Recent sync activity</h3>
          <ul className="yt-log">
            {s.log.slice(0, 10).map((e) => <li key={`${e.at}-${e.text}`}><span className="grow">{e.text}</span><span className="t-caption">{relative(e.at)}</span></li>)}
          </ul>
        </div>
      )}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" onClick={() => download('arnav-youtube-music-links.json', exportLinks())} disabled={!links.length}><Icon name="download" size={15} /> Export linked playlists</button>
        <button className="btn btn-ghost" onClick={() => { void disconnect(); toast('YouTube Music disconnected — your playlists stay here') }}><Icon name="logout" size={15} /> Disconnect</button>
      </div>
    </div>
  )
}

function LinkRow({ l, name, open }: { l: YtLink; name: string; open: () => void }) {
  const state = l.error ? `Problem: ${l.error}` : l.pending ? 'Waiting to sync' : l.syncedAt ? `Synced ${relative(l.syncedAt)}` : 'Not synced yet'
  return (
    <div className="yt-link">
      <button className="grow col yt-link-name" onClick={open} style={{ gap: 0, minWidth: 0, textAlign: 'left' }}>
        <span className="ellipsis" style={{ fontWeight: 600 }}>{name}</span>
        <span className={`t-caption ${l.error ? 'yt-err' : ''}`}>{state}</span>
      </button>
      <select className="chip-select" aria-label={`Sync direction for ${name}`} value={l.mode} onChange={(e) => { setMode(l.arnavId, e.target.value as SyncMode); void syncNow() }}>
        {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
      </select>
      <a className="icon-btn sm" href={ytMusicUrl(l.ytId)} target="_blank" rel="noreferrer" aria-label={`Open ${name} in YouTube Music`}><Icon name="external" size={15} /></a>
      <button className="icon-btn sm" aria-label={`Unlink ${name}`} title="Unlink (both copies stay)" onClick={() => { unlink(l.arnavId); toast(`“${name}” unlinked — both copies stay`) }}><Icon name="close" size={15} /></button>
    </div>
  )
}

/** After connecting: choose which YouTube Music playlists to link, and how the first sync combines. */
export function YtLinkReview() {
  const open = useYtMusic((s) => s.reviewOpen)
  const remote = useYtMusic((s) => s.remote)
  const links = useYtMusic((s) => s.links)
  const likesSync = useYtMusic((s) => s.likesSync)
  const playlists = useLibrary((s) => s.playlists)
  const close = () => useYtMusic.setState({ reviewOpen: false })
  const linkedYt = useMemo(() => new Map(Object.values(links).map((l) => [l.ytId, l.arnavId])), [links])
  const rows = useMemo(() => (remote ?? []).map((r) => {
    // A copy from the earlier one-way import becomes the linked playlist (no re-import, edits kept).
    const copy = visiblePlaylists(playlists).find((p) => importedYtId(p.id) === r.id) ?? null
    return { r, copy, linkedTo: linkedYt.get(r.id) ?? null }
  }), [remote, playlists, linkedYt])
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [first, setFirst] = useState<Record<string, FirstLink>>({})
  const isPicked = (id: string) => picked[id] ?? true
  const importedLikes = visiblePlaylists(playlists).find((p) => p.id === 'ytimp_LL') ?? null
  const choices = rows.filter((x) => !x.linkedTo && isPicked(x.r.id))
  const apply = () => {
    for (const x of choices) link(x.r.id, x.copy?.id ?? null, x.copy ? (first[x.r.id] ?? 'both') : 'youtube')
    if (choices.length) toast(`Linked ${choices.length} ${choices.length === 1 ? 'playlist' : 'playlists'} — syncing now`)
    close()
    void syncNow()
  }
  return (
    <Sheet open={open} onClose={close} title="Link with YouTube Music" width={600}>
      <div className="col" style={{ gap: 12 }}>
        <p className="t-sub" style={{ margin: 0 }}>Linked playlists stay the same in both apps. Your earlier imports become linked — your edits here are kept.</p>
        <div className="yt-review-row">
          <span className="sb-pl-art liked" style={{ width: 44, height: 44 }}><Icon name="heartFill" size={18} /></span>
          <span className="grow col" style={{ gap: 0 }}><b>Liked Songs</b><span className="t-caption">Likes here ↔ YouTube Music’s Liked Songs (songs only). First sync keeps likes from both.</span></span>
          <Toggle on={likesSync} label="Sync Liked Songs" onChange={(v) => useYtMusic.setState({ likesSync: v })} />
        </div>
        {importedLikes && (
          <Notice tone="info" icon="heart" action={<button className="btn btn-secondary btn-sm" onClick={() => { const n = moveImportedLikes(importedLikes.id); toast(`Moved ${n} songs into Liked Songs`) }}>Move into Liked Songs</button>}>
            Your imported “{importedLikes.name}” copy can go into Liked Songs, which then stays in sync.
          </Notice>
        )}
        <div className="yt-review-list">
          {rows.length === 0 && <div className="t-sub">No playlists on this YouTube account yet.</div>}
          {rows.map(({ r, copy, linkedTo }) => (
            <div key={r.id} className={`yt-review-row ${linkedTo ? 'done' : ''}`}>
              {linkedTo ? <span className="check on" aria-hidden><Icon name="check" size={13} strokeWidth={2.6} /></span> : (
                <button className={`check ${isPicked(r.id) ? 'on' : ''}`} role="checkbox" aria-checked={isPicked(r.id)} aria-label={`Link ${r.title}`} onClick={() => setPicked({ ...picked, [r.id]: !isPicked(r.id) })}>
                  {isPicked(r.id) && <Icon name="check" size={13} strokeWidth={2.6} />}
                </button>
              )}
              <Artwork src={r.art} seed={r.title} className="imp-art" />
              <span className="grow col" style={{ gap: 0, minWidth: 0 }}>
                <span className="ellipsis" style={{ fontWeight: 600 }}>{r.title}</span>
                <span className="t-caption ellipsis">{linkedTo ? 'Linked' : copy ? `${r.count} songs · links to your copy here` : `${r.count} songs · will be added here`}</span>
              </span>
              {!linkedTo && copy && isPicked(r.id) && (
                <select className="chip-select" aria-label={`First sync for ${r.title}`} value={first[r.id] ?? 'both'} onChange={(e) => setFirst({ ...first, [r.id]: e.target.value as FirstLink })}>
                  <option value="both">Keep songs from both</option>
                  <option value="youtube">Use YouTube Music’s</option>
                  <option value="arnav">Use Arnav’s</option>
                </select>
              )}
            </div>
          ))}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={close}>Not now</button>
          <button className="btn btn-primary" onClick={apply}>{choices.length ? `Link ${choices.length} ${choices.length === 1 ? 'playlist' : 'playlists'}` : 'Done'}</button>
        </div>
      </div>
    </Sheet>
  )
}

/** On a playlist page: where it stands with YouTube Music, or a way to put it there. */
export function PlaylistYtChip({ id, local }: { id: string; local: boolean }) {
  const l = useYtMusic((s) => s.links[id])
  const connected = useYtMusic((s) => s.connected)
  const status = useYtMusic((s) => s.status)
  const [busy, setBusy] = useState(false)
  if (!l) {
    if (!local) return null
    return (
      <button className="btn btn-secondary btn-sm yt-add" disabled={busy} onClick={async () => { setBusy(true); const ok = await addToYouTube(id); setBusy(false); if (ok) toast('Adding it to YouTube Music — songs follow in a moment') }}>
        {busy ? <Spinner size={13} /> : <Icon name="youtube" size={14} />} {connected ? 'Add to YouTube Music' : 'Sync with YouTube Music'}
      </button>
    )
  }
  const syncing = status === 'syncing'
  const label = status === 'needs-pass' && l.pending ? 'YouTube Music · waiting to reconnect' : l.error ? 'YouTube Music · needs attention' : l.pending || syncing ? 'YouTube Music · syncing' : `YouTube Music · synced ${relative(l.syncedAt)}`
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
      <span className={`yt-chip ${l.error ? 'err' : l.pending ? 'pending' : 'ok'}`}>
        <motion.span className="yt-chip-icon" animate={syncing ? { rotate: 360 } : { rotate: 0 }} transition={syncing ? { repeat: Infinity, duration: 1.2, ease: 'linear' } : { duration: 0.3 }} aria-hidden>
          <Icon name={l.error ? 'info' : syncing || l.pending ? 'sync' : 'check'} size={12} />
        </motion.span>
        {label}
      </span>
      {status === 'needs-pass' && l.pending && <button className="btn btn-primary btn-sm" onClick={() => void reconnect()}>Reconnect</button>}
      <a className="btn btn-ghost btn-sm" href={ytMusicUrl(l.ytId)} target="_blank" rel="noreferrer"><Icon name="external" size={13} /> Open in YouTube Music</a>
    </span>
  )
}

/** True for a few seconds after this song arrived from YouTube Music (the row glows once). */
export function useArrived(playlistId: string | undefined, trackId: string): boolean {
  return useYtMusic((s) => {
    if (!playlistId) return false
    const a = s.arrivals[playlistId]
    return !!a && Date.now() - a.at < 6000 && a.ids.includes(trackId)
  })
}


function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** How tidy the synced library is, with the fix for each finding. */
function LibraryHealth() {
  const nav = useNavigate()
  const links = useYtMusic((s) => s.links)
  const playlists = useLibrary((s) => s.playlists)
  const h = useMemo(() => {
    const ids = Object.keys(links).flatMap((id) => playlists[id]?.trackIds ?? [])
    const unique = [...new Set(ids)]
    const tracks = trackRegistry.many(unique)
    return {
      songs: unique.length,
      waiting: Object.values(links).filter((l) => l.pending).length,
      problems: Object.values(links).filter((l) => l.error).length,
      unofficial: tracks.filter((t) => t.trust != null && t.trust <= 0).length,
      duplicates: findDuplicates().length,
    }
  }, [links, playlists])
  const items: { label: string; value: string; tone: 'ok' | 'warn'; action?: { label: string; run: () => void } }[] = [
    { label: 'Songs in linked playlists', value: String(h.songs), tone: 'ok' },
    { label: 'Playlists waiting to sync', value: String(h.waiting), tone: h.waiting ? 'warn' : 'ok' },
    { label: 'Playlists that need attention', value: String(h.problems), tone: h.problems ? 'warn' : 'ok' },
    { label: 'Songs saved as more than one upload', value: String(h.duplicates), tone: h.duplicates ? 'warn' : 'ok', action: h.duplicates ? { label: 'Tidy up', run: () => nav('/library?tidy=duplicates') } : undefined },
    { label: 'Unofficial uploads (covers, fan edits)', value: String(h.unofficial), tone: h.unofficial ? 'warn' : 'ok' },
  ]
  return (
    <div>
      <h3 className="t-eyebrow" style={{ margin: '6px 0 10px' }}>Library health</h3>
      <div className="yt-health">
        {items.map((it) => (
          <div key={it.label} className={`yt-health-item ${it.tone}`}>
            <b className="tabular">{it.value}</b>
            <span className="t-caption">{it.label}</span>
            {it.action && <button className="btn btn-ghost btn-sm" onClick={it.action.run}>{it.action.label}</button>}
          </div>
        ))}
      </div>
    </div>
  )
}

/** On a smart playlist or Daily mix: keep it on YouTube Music too (refreshed weekly). */
export function PinMixButton({ source }: { source: string }) {
  const pinned = useYtMusic((s) => !!s.pins[source])
  const count = useYtMusic((s) => Object.keys(s.pins).length)
  const [busy, setBusy] = useState(false)
  if (pinned) return <button className="btn btn-secondary btn-sm" onClick={() => { unpin(source); toast('Unpinned — the YouTube Music copy stays but won’t refresh') }}><Icon name="check" size={14} /> On YouTube Music · weekly</button>
  return (
    <button className="btn btn-secondary btn-sm" disabled={busy || count >= MAX_PINS} title={count >= MAX_PINS ? `Up to ${MAX_PINS} mixes can be pinned` : 'A YouTube Music playlist that refreshes every week'}
      onClick={async () => { setBusy(true); const ok = await pinToYouTube(source); setBusy(false); if (ok) toast('Pinned to YouTube Music — it refreshes every week') }}>
      {busy ? <Spinner size={13} /> : <Icon name="youtube" size={14} />} Pin to YouTube Music
    </button>
  )
}
