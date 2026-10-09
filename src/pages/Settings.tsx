import { useEffect, useState, type ReactNode } from 'react'
import { deleteProfile, updateProfile, useSocial } from '../services/social'
import { glassFor, usePrefs, type GlassPref } from '../state/prefs'
import { importPhoneBackup, latestPhoneBackup, type ImportResult, type PhoneBackup } from '../services/phoneBackup'
import { useNavigate, useParams } from 'react-router-dom'
import { motion } from 'motion/react'
import { Icon, Logo, type IconName } from '../components/Icon'
import { Notice, PageHeader, Segmented, Sheet, Spinner, Toggle } from '../components/ui'
import { useSettings, regionCode, defaultAutomix, automixPatch, type Settings, type AutomixStyle, type PlayerBarPreset } from '../state/settings'
import { useAuth } from '../state/auth'
import { ui, toast } from '../state/ui'
import { useLibrary } from '../state/library'
import { useUsage, quotaDay } from '../lib/usage'
import { ytQuotaState } from '../lib/youtube'
import { idbClear } from '../lib/idb'
import { authMessage, linkGoogle, signOutUser, unlinkGoogle } from '../lib/firebase'
import { lastAiError } from '../lib/ai'
import { useWeather } from '../services/weather'
import { setThemeWithReveal } from '../lib/reveal'
import { SIGNALS, SIGNAL_COPY, tuner } from '../lib/tuner'
import { useSyncExternalStore } from 'react'
import { adoptAccount, deleteCloudData, deviceId, refreshAuthUser, syncNow, useSync } from '../services/sync'
import { useApiStatus } from '../services/status'
import { syncLabel } from '../components/Shell'
import { relative } from '../lib/format'

type Section = 'account' | 'appearance' | 'playback' | 'lyrics' | 'ai' | 'sources' | 'sync' | 'usage' | 'privacy' | 'about'
const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: 'account', label: 'Account', icon: 'user' }, { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'playback', label: 'Playback', icon: 'play' }, { id: 'lyrics', label: 'Lyrics', icon: 'lyrics' },
  { id: 'ai', label: 'Arnav AI', icon: 'sparkles' }, { id: 'sources', label: 'Sources', icon: 'youtube' },
  { id: 'sync', label: 'Data & sync', icon: 'cloud' }, { id: 'usage', label: 'Usage & quotas', icon: 'chart' },
  { id: 'privacy', label: 'Privacy', icon: 'info' }, { id: 'about', label: 'About', icon: 'note' },
]

function Row({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="set-title">{title}</div>
        {sub && <div className="t-caption set-sub">{sub}</div>}
      </div>
      {children}
    </div>
  )
}

function Bool({ k, title, sub }: { k: keyof Settings; title: string; sub?: string }) {
  const v = useSettings((s) => s[k]) as boolean
  return <Row title={title} sub={sub}><Toggle on={v} label={title} onChange={(on) => useSettings.getState().update({ [k]: on } as Partial<Settings>)} /></Row>
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="set-group">
      {title && <div className="t-eyebrow set-group-title">{title}</div>}
      <div className="set-card">{children}</div>
    </div>
  )
}

const ACCENTS = ['#8C7CFF', '#52D6C3', '#FF6B8B', '#FF9F43', '#4ADE80', '#38BDF8', '#F472B6', '#FACC15']

function Account() {
  const user = useAuth((s) => s.user)
  const status = useSync((s) => s.status)
  if (!user) {
    return (
      <Group>
        <div className="set-hero">
          <Logo size={52} />
          <div className="grow">
            <div className="t-title">Sign in to sync with your phone</div>
            <div className="t-sub">Use the same Google or email account as the Arnav Music Android app. Likes, playlists, listening history and your queue follow you.</div>
          </div>
          <button className="btn btn-primary" onClick={() => ui().set({ authOpen: true })}>Sign in</button>
        </div>
      </Group>
    )
  }
  return (
    <>
      <Group>
        <div className="set-hero">
          {user.photoURL ? <img src={user.photoURL} className="avatar" style={{ width: 56, height: 56 }} alt="" referrerPolicy="no-referrer" /> : <span className="avatar ph" style={{ width: 56, height: 56 }}><Icon name="user" size={24} /></span>}
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="t-title ellipsis">{user.displayName || 'Arnav Music listener'}</div>
            <div className="t-sub ellipsis">{user.email}</div>
            <div className="t-caption">{syncLabel(status)} · {user.providers.includes('google.com') ? 'Google' : 'Email'} account</div>
          </div>
          <button className="btn btn-secondary" onClick={() => void signOutUser().then(() => toast('Signed out'))}><Icon name="logout" size={15} /> Sign out</button>
        </div>
      </Group>
      <LinkedAccounts />
    </>
  )
}

function LinkedAccounts() {
  const user = useAuth((s) => s.user)
  const [busy, setBusy] = useState(false)
  if (!user) return null
  const google = user.providers.includes('google.com')
  const email = user.providers.includes('password')
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try { await fn(); refreshAuthUser(); toast(done) } catch (e) { toast(authMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Group title="Linked accounts">
      <Row title={<span className="row" style={{ gap: 8 }}><Icon name="google" size={16} /> Google</span>}
        sub={google ? 'Linked \u2014 you can sign in with Google and import your YouTube playlists.' : 'Link Google to sign in with it and to import your YouTube playlists and Liked videos. Your library stays the same.'}>
        {google
          ? (email ? <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(unlinkGoogle, 'Google unlinked')}>Unlink</button> : <span className="badge">Linked</span>)
          : <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(linkGoogle, 'Google account linked')}>{busy ? <Spinner size={13} /> : <Icon name="link" size={14} />} Link Google</button>}
      </Row>
      <Row title={<span className="row" style={{ gap: 8 }}><Icon name="user" size={16} /> Email &amp; password</span>} sub={email ? user.email : 'Not set up \u2014 you sign in with Google.'}>
        {email && <span className="badge">Linked</span>}
      </Row>
    </Group>
  )
}

function Appearance() {
  const s = useSettings()
  return (
    <>
      <Group title="Theme">
        <Row title="Appearance"><Segmented id="theme" size="sm" value={s.themeMode} onChange={(v) => setThemeWithReveal(v)} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'Auto' }]} /></Row>
        <Row title="Accent colour" sub="Follow the artwork, or pick a colour"><Segmented id="accent" size="sm" value={s.accentMode} onChange={(v) => s.update({ accentMode: v })} options={[{ value: 'artwork', label: 'Artwork' }, { value: 'preset', label: 'Fixed' }]} /></Row>
        {s.accentMode === 'preset' && (
          <div className="accent-row">
            {ACCENTS.map((a) => <button key={a} className={`accent-dot ${s.presetAccent === a ? 'on' : ''}`} style={{ background: a }} aria-label={`Accent ${a}`} onClick={() => s.update({ presetAccent: a })} />)}
          </div>
        )}
        <Bool k="glass" title="Liquid Glass" sub="Translucent materials that blur and refract what’s behind them. Off uses solid surfaces." />
        <GlassControls />
        <Bool k="highContrast" title="Increase contrast" />
      </Group>
      <Group title="Motion">
        <Row title="Animations" sub="Reduced keeps transitions short; Off removes them"><Segmented id="motion" size="sm" value={s.motion} onChange={(v) => s.update({ motion: v })} options={[{ value: 'full', label: 'Full' }, { value: 'reduced', label: 'Reduced' }, { value: 'off', label: 'Off' }]} /></Row>
        <Bool k="movingGradient" title="Living Now Playing" sub="The background drifts through the cover’s colours" />
        <Bool k="coverBreathing" title="Cover breathing" sub="Artwork settles back when paused" />
        <Bool k="ambientIdle" title="Ambient idle" sub="Now Playing fades to just the music after a few seconds" />
        <Bool k="coverParticles" title="Cover particles" sub="The old cover dissolves into particles as the new one forms" />
        <Bool k="vinylMode" title="Vinyl" sub="The record slides out of its sleeve and spins while the song plays" />
        <Bool k="beatVisuals" title="Beat visuals" sub="A living background that moves with the song's energy and tempo (synced with the app)" />
        <PlayerBarRow />
        <Bool k="dockedPlayer" title="Docked Now Playing (desktop)" sub="Keep the cover, lyrics and queue in a panel beside the page" />
      </Group>
    </>
  )
}

export const AUTOMIX_OPTIONS: { value: AutomixStyle; label: string; sub: string }[] = [
  { value: 'smart', label: 'Smart', sub: 'Each pair of songs gets its own blend: short for big mood changes, long and soft for calm ones, gapless inside an album, early before a music video’s outro.' },
  { value: 'crossfade', label: 'Crossfade', sub: 'Every song fades into the next over the same length.' },
  { value: 'gapless', label: 'Gapless', sub: 'The next song starts the moment this one ends — no silence.' },
  { value: 'off', label: 'Off', sub: 'Songs play one after another.' },
]

function Playback() {
  const s = useSettings()
  const style = defaultAutomix(s)
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  return (
    <>
    <Group title="Automix">
      <Row title="Transitions" sub={`${AUTOMIX_OPTIONS.find((o) => o.value === style)?.sub ?? ''}${iOS ? ' On iPhone and iPad only one video can play at a time, so songs hand over without a blend.' : ''} Synced with the app. Playlists can have their own.`}>
        <Segmented id="automix" size="sm" value={style} onChange={(v) => s.update(automixPatch(v, s))} options={AUTOMIX_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
      </Row>
      {style === 'smart' && (
        <Row title="Pick the next song by mood" sub="When the order isn't the point (shuffle, radio, mixes and AI sessions), Smart automix chooses which of the next songs fits the moment — energy, tempo and genre, with Arnav AI's pick when it's on. Playlists and albums keep their order.">
          <Toggle on={s.moodAutomix} onChange={(v) => s.update({ moodAutomix: v })} label="Pick the next song by mood" />
        </Row>
      )}
      {(style === 'crossfade' || style === 'smart') && (
        <Row title="Crossfade length" sub={style === 'smart' ? 'The starting point — Smart lengthens or shortens it for each pair.' : undefined}>
          <div className="row" style={{ gap: 10 }}>
            <input type="range" className="range" min={1000} max={12000} step={500} value={s.crossfadeMs || 6000} onChange={(e) => s.update({ crossfadeMs: Number(e.target.value) })} aria-label="Crossfade length" style={{ width: 160 }} />
            <span className="t-caption" style={{ minWidth: 36 }}>{((s.crossfadeMs || 6000) / 1000).toFixed(1)} s</span>
          </div>
        </Row>
      )}
    </Group>
    <Group>
      <Bool k="verifiedOnly" title="Verified music only" sub="Official uploads only: YouTube Topic art tracks, VEVO, record labels, artists' own channels and established channels. Covers, karaoke, reactions, slowed/8D edits and Shorts are always left out." />
      <Bool k="endlessRadio" title="Endless radio" sub="When the queue ends, keep playing similar songs" />
      <Bool k="autoReplaceUnavailable" title="Rescue unplayable videos" sub="Automatically find another upload when one can’t be embedded" />
      <Bool k="autoVideos" title="Music videos for my library" sub="Find the official music video of every song in your playlists and Liked Songs in the background, so Video mode switches instantly. Shared with all listeners, so it costs almost nothing." />
      <Bool k="crossfadeOnSkip" title="Smooth transitions" sub="Fade out and in when you skip" />
      <Bool k="explanations" title="Show why" sub="One honest line under each recommendation" />
    </Group>
    </>
  )
}

function Lyrics() {
  return (
    <Group>
      <Bool k="onlineLyrics" title="Online lyrics" sub="Time-synced lyrics from LRCLIB and NetEase, checked against the song’s real length (Apple Music), the uploader’s own lyrics and what other listeners picked. Cached in this browser." />
      <Bool k="autoAlignLyrics" title="Fit lyrics to music videos" sub="Lyrics are timed to the audio release; when a video has extra scenes first, shift them to match." />
      <LyricsScript />
      <Bool k="miniPlayerLyrics" title="Lyrics in the player bar" sub="The line being sung, under the song title" />
    </Group>
  )
}

function PlayerBarRow() {
  const s = useSettings()
  const opts: { value: PlayerBarPreset; label: string }[] = [{ value: 'compact', label: 'Compact' }, { value: 'wide', label: 'Wide' }, { value: 'studio', label: 'Studio' }]
  return (
    <Row title="Player bar (desktop)" sub="Studio adds a song map you can scrub, and shows the automix style.">
      <Segmented id="pbar" size="sm" value={s.playerBar} onChange={(v) => s.update({ playerBar: v })} options={opts} />
    </Row>
  )
}

function LyricsScript() {
  const s = useSettings()
  return (
    <Row title="Lyrics script" sub="When a song has lyrics in more than one script (e.g. Hindi in Devanagari and in Latin letters).">
      <Segmented id="lyr-script" size="sm" value={s.lyricsScript} onChange={(v) => s.update({ lyricsScript: v })} options={[{ value: 'auto', label: 'Like the title' }, { value: 'latin', label: 'Latin' }, { value: 'original', label: 'Original' }]} />
    </Row>
  )
}

function Ai() {
  const s = useSettings()
  const u = useUsage()
  return (
    <>
      <Group>
        <Bool k="aiEnabled" title="Arnav AI cloud" sub="Uses Gemini through Firebase AI Logic. When off or unavailable, the on-device engine answers." />
        <Bool k="aiPersonalization" title="Personalise with my taste" sub="Sends your top artists and genres (never history) with each request" />
        <Bool k="aiDj" title="AI DJ" sub="A short spoken intro as each new song starts. The voice is generated on this device; the music dips under it." />
        <Row title="Weather moods" sub="Uses your approximate location (only with your permission) to match Home and Moments to the weather. Weather from Open-Meteo.">
          <Toggle on={useSettings((s) => s.weatherMoods)} label="Weather moods" onChange={(on) => { if (on) void useWeather.getState().refresh(true); else useSettings.getState().update({ weatherMoods: false }) }} />
        </Row>
        <Row title="Daily request limit" sub={`${u.aiRequests} used today`}>
          <input className="field" style={{ width: 90 }} type="number" min={0} max={500} value={s.dailyAiLimit} onChange={(e) => s.update({ dailyAiLimit: Math.max(0, Math.min(500, Number(e.target.value) || 0)) })} />
        </Row>
      </Group>
      <Tuner />
      {lastAiError && <Notice tone="info">Last cloud AI error: {lastAiError}</Notice>}
    </>
  )
}

function Tuner() {
  const st = useSyncExternalStore(tuner.subscribe, tuner.stats, tuner.stats)
  return (
    <Group title="Recommendations learn from you">
      <div className="set-row col" style={{ alignItems: 'stretch', gap: 12 }}>
        <div className="t-caption">Every recommended song remembers why it was picked. Finishing it strengthens those reasons; an early skip weakens them. {st.plays ? `Learned from ${st.plays} recommended ${st.plays === 1 ? 'play' : 'plays'} — ${st.finished} finished, ${st.skipped} skipped.` : 'Nothing learned yet — play some recommendations.'}</div>
        {SIGNALS.map((k) => {
          const v = st.m[k]
          return (
            <div key={k} className="tune-row">
              <div className="tune-label"><span className="set-title">{SIGNAL_COPY[k].label}</span><span className="t-caption">{SIGNAL_COPY[k].line}</span></div>
              <div className="tune-bar" aria-label={`${SIGNAL_COPY[k].label}: ${Math.round(v * 100)}%`}><i style={{ transform: `scaleX(${Math.min(1, v / 2.5)})` }} /><b style={{ left: `${(1 / 2.5) * 100}%` }} /></div>
              <span className="t-caption tabular" style={{ width: 44, textAlign: 'right' }}>{v >= 1 ? '+' : ''}{Math.round((v - 1) * 100)}%</span>
            </div>
          )
        })}
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn btn-ghost btn-sm" onClick={() => { tuner.reset(); toast('Recommendation tuning reset') }}>Reset</button></div>
      </div>
    </Group>
  )
}

function Sources() {
  const s = useSettings()
  const api = useApiStatus()
  const [key, setKey] = useState(s.youtubeKey)
  const [show, setShow] = useState(false)
  return (
    <>
      <Group title="YouTube">
        <Row title="Server key" sub={api.checked ? (api.serverKey ? 'This site has a YouTube Data API key configured.' : 'No key is configured on this server.') : 'Checking…'}>
          <span className={`badge ${api.serverKey ? '' : 'yt'}`}>{api.serverKey ? 'Connected' : 'Missing'}</span>
        </Row>
        <div className="set-row col" style={{ alignItems: 'stretch', gap: 8 }}>
          <div className="set-title">Your own API key <span className="t-caption">(optional)</span></div>
          <div className="t-caption">Overrides the server key for this browser only. It stays in this browser and is never synced. Create one in Google Cloud → Credentials, restricted to YouTube Data API v3.</div>
          <div className="row">
            <input className="field" type={show ? 'text' : 'password'} value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" autoComplete="off" spellCheck={false} />
            <button className="icon-btn" aria-label={show ? 'Hide key' : 'Show key'} onClick={() => setShow(!show)}><Icon name={show ? 'close' : 'info'} size={17} /></button>
            <button className="btn btn-primary" onClick={() => { s.update({ youtubeKey: key.trim() }); toast(key.trim() ? 'Key saved in this browser' : 'Key removed') }}>Save</button>
          </div>
        </div>
        <Row title="Daily unit budget" sub="Match your Google Cloud quota (default 10,000). Near 80% Arnav Music conserves.">
          <input className="field" style={{ width: 110 }} type="number" min={100} step={500} value={s.youtubeDailyBudget} onChange={(e) => s.update({ youtubeDailyBudget: Math.max(100, Number(e.target.value) || 10000) })} />
        </Row>
        <Row title="Region" sub={`Charts and search region. Detected: ${regionCode()}`}>
          <input className="field" style={{ width: 80, textTransform: 'uppercase' }} maxLength={2} value={s.regionCode} placeholder="Auto" onChange={(e) => s.update({ regionCode: e.target.value.replace(/[^a-z]/gi, '').toUpperCase() })} />
        </Row>
      </Group>
      <Group title="Lyrics">
        <Row title="LRCLIB" sub="Free, open, community-maintained. No key needed."><span className="badge">Connected</span></Row>
      </Group>
    </>
  )
}

function PhoneBackupGroup({ uid }: { uid: string }) {
  const [backup, setBackup] = useState<PhoneBackup | null | undefined>(undefined)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  useEffect(() => { void latestPhoneBackup(uid).then(setBackup).catch(() => setBackup(null)) }, [uid])
  const run = async () => {
    if (!backup) return
    setProgress(0)
    try { setResult(await importPhoneBackup(uid, backup, setProgress)) } catch (e) { toast(e instanceof Error ? e.message : 'The backup couldn’t be opened') } finally { setProgress(null) }
  }
  return (
    <Group title="From your phone">
      <Row
        title="Bring in your phone’s library"
        sub={backup === undefined ? 'Looking for the app’s cloud backup…' : backup
          ? `Backup from ${backup.device} · ${relative(backup.createdAt)} · ${(backup.counts.play_events ?? 0).toLocaleString()} plays, ${(backup.counts.lyrics ?? 0).toLocaleString()} lyrics, ${(backup.counts.recent_searches ?? 0).toLocaleString()} searches. Adds what isn’t synced live: older listening history, recent searches, hidden songs, blocked artists and the lyrics you saved or re-timed. Nothing on the phone changes.`
          : 'No app backup yet. The app makes one about once an hour while “Cloud sync & backup” is on in its settings.'}
      >
        <button className="btn btn-secondary btn-sm" disabled={!backup || progress != null} onClick={() => void run()}>
          {progress != null ? <><Spinner size={13} /> {Math.round(progress * 100)}%</> : <><Icon name="download" size={14} /> Bring in</>}
        </button>
      </Row>
      {result && <Row title="Brought in" sub={`${result.history.toLocaleString()} plays · ${result.searches} searches · ${result.hidden} hidden songs · ${result.blocked} blocked artists · ${result.lyrics} lyrics`} />}
    </Group>
  )
}

function SyncSection() {
  const user = useAuth((s) => s.user)
  const sync = useSync()
  const cloud = useSettings((s) => s.cloudSync)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <Group>
        <Bool k="cloudSync" title="Cloud sync" sub="Likes, playlists, listening history, your queue and settings sync with the Android app. Web extras — playlist automix, lyric fixes, hidden songs, blocked artists, saved YouTube playlists, recent searches and the recommendation tuner — follow you to every browser." />
        <Bool k="syncSettings" title="Sync settings with my phone" sub="Theme, accent, motion, Arnav AI, playback, lyrics and taste preferences follow you both ways. Phone-only choices (like OLED) are kept on the phone." />
        {user && cloud && <Row title="Continue on your phone" sub="Send your queue, scan a QR code, or see your devices"><button className="btn btn-secondary btn-sm" onClick={() => ui().set({ phoneOpen: true })}><Icon name="phone" size={14} /> Open</button></Row>}
        <Row title="Status" sub={sync.error ?? (sync.lastSyncedAt ? `Last synced ${relative(sync.lastSyncedAt)}` : user ? 'Not synced yet' : 'Sign in to sync')}>
          <span className="badge">{user ? syncLabel(sync.status) : 'Signed out'}</span>
        </Row>
        {user && cloud && (
          <Row title="Sync now">
            <button className="btn btn-secondary btn-sm" disabled={sync.status === 'SYNCING'} onClick={() => void syncNow()}>{sync.status === 'SYNCING' ? <Spinner size={13} /> : <Icon name="sync" size={15} />} Sync</button>
          </Row>
        )}
        {sync.status === 'ACCOUNT_BLOCKED' && user && (
          <div className="set-row col" style={{ alignItems: 'stretch' }}>
            <Notice tone="warn">This browser holds another account’s library. Load this account’s library to continue — the other account’s data stays safe in its own cloud.</Notice>
            <button className="btn btn-primary" onClick={() => void adoptAccount(user.uid)}>Load {user.email}’s library</button>
          </div>
        )}
        <Row title="Pulled from your devices this session" sub={`${sync.pulled.likes} likes · ${sync.pulled.playlists} playlists · ${sync.pulled.history} plays`} />
        <Row title="This browser" sub={<span className="mono">{deviceId}</span>} />
      </Group>
      {user && cloud && <PhoneBackupGroup uid={user.uid} />}
      {user && (
        <Group title="Danger zone">
          <Row title="Delete cloud data" sub="Removes likes, playlists, history, backups and devices from your account’s cloud. Local data stays.">
            <button className="btn btn-danger btn-sm" onClick={() => setConfirm(true)}><Icon name="trash" size={14} /> Delete</button>
          </Row>
        </Group>
      )}
      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Delete all cloud data?" width={440}>
        <div className="t-sub">This deletes everything Arnav Music stored in the cloud for {user?.email} — including what your phone synced and its backups. It can’t be undone. Cloud sync turns off.</div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <button className="btn btn-danger" disabled={busy} onClick={async () => { setBusy(true); try { await deleteCloudData(); toast('Cloud data deleted') } catch (e) { toast(e instanceof Error ? e.message : 'Delete failed') } finally { setBusy(false); setConfirm(false) } }}>{busy ? <Spinner size={14} /> : <Icon name="trash" size={14} />} Delete everything</button>
        </div>
      </Sheet>
    </>
  )
}

function Usage() {
  const u = useUsage()
  const budget = useSettings((s) => s.youtubeDailyBudget)
  const state = ytQuotaState()
  const pct = Math.min(1, u.units / budget)
  return (
    <>
      <Group title={`Today · resets at midnight Pacific (${quotaDay()})`}>
        <div className="set-row col" style={{ alignItems: 'stretch', gap: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="set-title">YouTube Data API</span>
            <span className={`badge ${state !== 'NORMAL' ? 'yt' : ''}`}>{state === 'NORMAL' ? 'Normal' : state === 'CONSERVE' ? 'Conserving' : 'Exhausted'}</span>
          </div>
          <div className="quota-bar"><motion.i initial={{ scaleX: 0 }} animate={{ scaleX: pct }} transition={{ duration: 0.8, ease: [0.32, 0.72, 0, 1] }} className={state} /></div>
          <div className="t-caption">{u.units.toLocaleString()} of {budget.toLocaleString()} units · {u.remoteSearches} searches · {u.calls} calls · {u.cacheHits} answered from cache</div>
        </div>
        <Row title="Arnav AI (Gemini)" sub={`${u.aiRequests} requests · ${u.aiCacheHits} cached · ${u.aiFallbacks} answered on device`} />
        <Row title="Firestore" sub={`${u.firestoreReads} reads · ${u.firestoreWrites} writes (free quota: 50k reads / 20k writes a day)`} />
        <Row title="Lyrics lookups" sub={`${u.lyricsLookups} LRCLIB lookups`} />
      </Group>
      <Notice tone="info">Search results are cached and reused for a day (a week when conserving). Edge caching on the server shares results between visitors, saving quota for everyone.</Notice>
    </>
  )
}

/** Liquid Glass style and strength — saved for this device, synced with your account. */
function GlassControls() {
  const on = useSettings((x) => x.glass)
  const all = usePrefs((x) => x.glass)
  const g = glassFor(all, deviceId)
  const set = (p: Partial<Omit<GlassPref, 'at' | 'history'>>) => usePrefs.getState().setGlass(deviceId, p)
  const others = Object.keys(all).filter((k) => k !== deviceId).length
  const history = all[deviceId]?.history ?? []
  if (!on) return null
  return (
    <>
      <Row title="Glass style" sub={g.style === 'clear' ? 'Clear — see-through, like iOS 26’s clear glass.' : 'Tinted — frosted, coloured by the album playing.'}>
        <Segmented id="glass-style" size="sm" value={g.style} onChange={(v) => set({ style: v })} options={[{ value: 'tinted', label: 'Tinted' }, { value: 'clear', label: 'Clear' }]} />
      </Row>
      <div className="set-row set-row-stack">
        <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
          <div className="set-title">Glass strength</div>
          <b className="t-caption" style={{ fontVariantNumeric: 'tabular-nums' }}>{g.strength}%</b>
        </div>
        <input className="range glass-range" style={{ ["--fill" as string]: `${g.strength}%` }} type="range" min={0} max={100} step={5} value={g.strength} aria-label="Glass strength" onChange={(e) => set({ strength: Number(e.target.value) })} />
        <div className="t-caption set-sub">Saved for this device and synced with your account{others ? ` — your ${others} other device${others > 1 ? 's keep' : ' keeps'} its own` : ''}.</div>
      </div>
      <Row title="Adapt to the artwork" sub="Busier artwork behind the glass gets more frost, calm artwork stays clear — so text is always easy to read.">
        <Toggle on={g.adaptive} onChange={(v) => set({ adaptive: v })} label="Adapt glass to the artwork" />
      </Row>
      {history.length > 0 && (
        <div className="set-row set-row-stack">
          <div className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
            <div className="set-title">Glass history</div>
            <button className="btn btn-secondary btn-sm" onClick={() => usePrefs.getState().undoGlass(deviceId)}><Icon name="history" size={14} /> Undo</button>
          </div>
          <div className="glass-history">
            {history.slice(0, 6).map((h, i) => (
              <button key={h.at} className="chip" title="Go back to this" onClick={() => usePrefs.getState().undoGlass(deviceId, i)}>
                {h.style === 'clear' ? 'Clear' : 'Tinted'} · {h.strength}%{h.adaptive ? '' : ' · fixed'} <span className="t-caption">{relative(h.at)}</span>
              </button>
            ))}
          </div>
          <div className="t-caption set-sub">This device’s last changes — kept with your account, so you can undo them from here after a sync too.</div>
        </div>
      )}
    </>
  )
}

/** Friends: who sees what you play, and deleting your profile. */
function FriendsPrivacy() {
  const nav = useNavigate()
  const me = useSocial((s) => s.me)
  const [confirm, setConfirm] = useState(false)
  if (!me) return (
    <Group title="Friends">
      <Row title="Friends profile" sub="Not set up. Friends see what you play only if you create a profile.">
        <button className="btn btn-secondary btn-sm" onClick={() => nav('/friends')}>Set up</button>
      </Row>
    </Group>
  )
  return (
    <Group title="Friends">
      <Row title="Who sees what you play" sub={me.privacy === 'off' ? 'Private session — nobody sees your listening.' : me.privacy === 'everyone' ? 'Anyone who opens your profile.' : 'Only your friends.'}>
        <Segmented id="set-fr-privacy" size="sm" value={me.privacy} onChange={(v) => void updateProfile({ privacy: v })} options={[{ value: 'friends', label: 'Friends' }, { value: 'everyone', label: 'Everyone' }, { value: 'off', label: 'Private' }]} />
      </Row>
      <Row title={`@${me.handle}`} sub="Your Friends profile — what you share: your name, colour, what you play (as above), top artists and songs for taste match and Blend.">
        <button className="btn btn-secondary btn-sm" onClick={() => nav(`/u/${me.handle}`)}>View</button>
      </Row>
      <Row title="Delete Friends profile" sub="Removes your profile, friends, inbox and listening activity from Arnav Music’s servers.">
        <button className="btn btn-danger btn-sm" onClick={() => setConfirm(true)}>Delete</button>
      </Row>
      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Delete your Friends profile?" width={420}>
        <div className="t-sub">Your friends, messages and listening activity are removed for good. Your music library isn’t touched.</div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <button className="btn btn-danger" onClick={() => void deleteProfile().then(() => { setConfirm(false); toast('Friends profile deleted') }).catch(() => toast('Couldn’t delete — try again'))}>Delete</button>
        </div>
      </Sheet>
    </Group>
  )
}

function Privacy() {
  const nav = useNavigate()
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <Group>
        <Row title="What stays on this device" sub="Taste DNA, recommendations, smart playlists and recaps are computed in your browser. Nothing is sold or shared." />
        <Row title="What goes to the cloud" sub="Only when signed in with sync on: likes, Arnav playlists, listening events and an idle YouTube-only queue — under your account, readable only by you." />
        <Row title="AI requests" sub="Your request text (and, if enabled, top artists/genres) is sent to Gemini via Firebase AI Logic." />
      </Group>
      <FriendsPrivacy />
      <Group title="Local data">
        <Row title="Clear caches" sub="Search results, lyrics and AI answers saved in this browser">
          <button className="btn btn-secondary btn-sm" onClick={() => void idbClear('cache').then(() => toast('Caches cleared'))}>Clear</button>
        </Row>
        <Row title="Reset this browser" sub="Removes the local library, settings and caches here. Your cloud data is untouched.">
          <button className="btn btn-danger btn-sm" onClick={() => setConfirm(true)}>Reset</button>
        </Row>
      </Group>
      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Reset this browser?" width={420}>
        <div className="t-sub">Local likes, playlists, history, settings and caches on this browser are removed. If you’re signed in, they come back from the cloud on the next sync.</div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <button className="btn btn-danger" onClick={async () => {
            await idbClear('cache'); await idbClear('kv')
            try { localStorage.clear() } catch { /* ignore */ }
            useLibrary.getState().applyRemote({ likes: {}, playlists: {}, events: [], recentSearches: [], notInterested: [], blockedArtists: [], savedRemote: [] })
            nav('/welcome'); location.reload()
          }}>Reset</button>
        </div>
      </Sheet>
    </>
  )
}

function About() {
  return (
    <>
      <Group>
        <div className="set-hero">
          <Logo size={56} glow />
          <div className="grow">
            <div className="t-title t-brand">Arnav Music</div>
            <div className="t-sub">Music, alive. Web edition · same backend as the Android app.</div>
          </div>
        </div>
        <Row title="Android app" sub="Background edition with on-device music, widgets and Android Auto"><a className="btn btn-secondary btn-sm" href="https://github.com/Arnav-Dugad/Arnav-Music-Background/releases/latest" target="_blank" rel="noreferrer"><Icon name="download" size={14} /> Get the APK</a></Row>
        <Row title="Source" sub="Open source on GitHub"><a className="btn btn-ghost btn-sm" href="https://github.com/Arnav-Dugad/Arnav-Music-Website" target="_blank" rel="noreferrer"><Icon name="external" size={14} /> GitHub</a></Row>
        <Row title="Keyboard shortcuts"><button className="btn btn-ghost btn-sm" onClick={() => ui().set({ shortcutsOpen: true })}><Icon name="keyboard" size={14} /> Show</button></Row>
      </Group>
      <Group title="Credits">
        <Row title="Playback" sub="The official YouTube IFrame player. Music and videos belong to their owners; YouTube attribution stays intact." />
        <Row title="Lyrics" sub="LRCLIB (lrclib.net), community-maintained." />
        <Row title="AI" sub="Gemini via Firebase AI Logic." />
      </Group>
    </>
  )
}

export default function SettingsPage() {
  const { section } = useParams()
  const nav = useNavigate()
  const current = (SECTIONS.find((s) => s.id === section)?.id ?? 'account') as Section
  const body: Record<Section, ReactNode> = {
    account: <Account />, appearance: <Appearance />, playback: <Playback />, lyrics: <Lyrics />, ai: <Ai />,
    sources: <Sources />, sync: <SyncSection />, usage: <Usage />, privacy: <Privacy />, about: <About />,
  }
  return (
    <div className="page settings-page">
      <PageHeader title="Settings" />
      <div className="set-layout">
        <nav className="set-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} className={`set-nav-item ${current === s.id ? 'on' : ''}`} onClick={() => nav(`/settings/${s.id}`, { replace: true })}>
              <span className="set-nav-icon"><Icon name={s.icon} size={16} /></span>{s.label}
            </button>
          ))}
        </nav>
        <motion.div key={current} className="set-body" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.22 }}>
          <h2 className="t-title" style={{ marginBottom: 14 }}>{SECTIONS.find((s) => s.id === current)?.label}</h2>
          {body[current]}
        </motion.div>
      </div>
    </div>
  )
}
