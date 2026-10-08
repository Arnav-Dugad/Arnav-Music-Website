import { useEffect, useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'
import { Sheet, Spinner } from './ui'
import { Icon } from './Icon'
import { useUi, ui, toast } from '../state/ui'
import { usePlayer, useProgress } from '../state/player'
import { useAuth } from '../state/auth'
import { listDevices, sendQueueToPhone, type DeviceInfo } from '../services/sync'
import { relative } from '../lib/format'

export const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)

/** The Android app's deep link (arnavmusic://track/<videoId>), with the website as fallback. */
export function appIntentUrl(videoId: string): string {
  const fallback = `${location.origin}/track/${videoId}`
  return `intent://track/${videoId}#Intent;scheme=arnavmusic;package=com.arnav.music;S.browser_fallback_url=${encodeURIComponent(fallback)};end`
}

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  }, [text])
  return <div className="qr" aria-label="QR code" role="img" dangerouslySetInnerHTML={{ __html: svg }} />
}

export function PhoneSheet() {
  const open = useUi((s) => s.phoneOpen)
  const track = usePlayer((s) => s.queue[s.index]?.track ?? null)
  const queueLen = usePlayer((s) => s.queue.length)
  const user = useAuth((s) => s.user)
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null)
  const [sending, setSending] = useState(false)
  const [at, setAt] = useState(0)
  useEffect(() => {
    if (!open) return
    setAt(Math.floor(useProgress.getState().position / 1000))
    setDevices(null)
    if (user) void listDevices().then(setDevices)
  }, [open, user])
  const link = track ? `${location.origin}/track/${track.playbackRef}${at > 5 ? `?t=${at}` : ''}` : location.origin
  const close = () => ui().set({ phoneOpen: false })
  return (
    <Sheet open={open} onClose={close} title="Continue on your phone" width={480}>
      <div className="phone-grid">
        <div className="col" style={{ alignItems: 'center', gap: 8 }}>
          <Qr text={link} />
          <div className="t-caption" style={{ textAlign: 'center' }}>Scan with your phone’s camera{track ? ` — opens “${track.title}”${at > 5 ? ` at ${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}` : ''}` : ''}</div>
        </div>
        <div className="col" style={{ gap: 10 }}>
          <button className="btn btn-primary" disabled={!user || !queueLen || sending} onClick={async () => {
            setSending(true)
            try { await sendQueueToPhone(); close() } catch (e) { toast(e instanceof Error ? e.message : 'Couldn’t send') } finally { setSending(false) }
          }}>{sending ? <Spinner size={14} /> : <Icon name="phone" size={16} />} Send queue to phone</button>
          {!user && <div className="t-caption">Sign in with the same account as the app to send your queue.</div>}
          {track && isAndroid() && <a className="btn btn-secondary" href={appIntentUrl(track.playbackRef)}><Icon name="external" size={15} /> Open in Arnav Music app</a>}
          <button className="btn btn-ghost" onClick={() => { void navigator.clipboard?.writeText(link).then(() => toast('Link copied')) }}><Icon name="link" size={15} /> Copy link</button>
        </div>
      </div>
      {user && (
        <div style={{ marginTop: 18 }}>
          <div className="t-eyebrow" style={{ marginBottom: 8 }}>Your devices</div>
          {devices == null ? <Spinner size={16} /> : (
            <div className="col" style={{ gap: 2 }}>
              {devices.map((d) => (
                <div key={d.id} className="device-row">
                  <span className="device-icon"><Icon name={d.thisDevice ? 'globe' : 'phone'} size={16} /></span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>{d.label}{d.appVersion ? <span className="subtle"> · v{d.appVersion}</span> : null}</span>
                    <span className="t-caption ellipsis" style={{ display: 'block' }}>{d.thisDevice ? 'You’re here' : d.lastSeen ? `Last played ${d.lastTrack ? `“${d.lastTrack}” ` : ''}${relative(d.lastSeen)}` : 'No activity yet'}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}
