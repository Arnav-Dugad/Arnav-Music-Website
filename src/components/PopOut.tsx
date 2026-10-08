import { createRoot, type Root } from 'react-dom/client'
import { Artwork } from './ui'
import { Icon } from './Icon'
import { PlayPauseIcon } from './PlayerBar'
import { LikeButton } from './TrackRow'
import { usePlayer, player, useProgress } from '../state/player'
import { artworkFor } from '../lib/classify'
import { duration } from '../lib/format'
import { toast } from '../state/ui'

interface DocumentPiP { requestWindow(opts: { width: number; height: number }): Promise<Window>; window: Window | null }
const pipApi = (): DocumentPiP | null => (window as unknown as { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture ?? null
export const popOutSupported = () => typeof window !== 'undefined' && pipApi() != null

function MiniWindow() {
  const track = usePlayer((s) => s.queue[s.index]?.track ?? null)
  const playing = usePlayer((s) => s.wantPlaying)
  const pos = useProgress((s) => s.position)
  const dur = usePlayer((s) => s.duration || s.queue[s.index]?.track.durationMs || 0)
  if (!track) return <div className="pip-empty">Nothing playing</div>
  return (
    <div className="pip">
      <div className="pip-bg" style={{ backgroundImage: `url(${artworkFor(track)})` }} />
      <div className="pip-inner">
        <Artwork src={artworkFor(track)} className="pip-art" hi eager />
        <div className="pip-meta">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="pip-title ellipsis">{track.title}</div>
            <div className="pip-artist ellipsis">{track.artist}</div>
          </div>
          <LikeButton track={track} size={18} />
        </div>
        <div className="pip-prog"><i style={{ transform: `scaleX(${dur ? Math.min(1, pos / dur) : 0})` }} /></div>
        <div className="pip-times tabular"><span>{duration(pos)}</span><span>{duration(dur)}</span></div>
        <div className="pip-controls">
          <button className="icon-btn" aria-label="Previous" onClick={() => player().prev(useProgress.getState().position)}><Icon name="prevFill" size={22} /></button>
          <button className="pip-play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => player().toggle()}><PlayPauseIcon playing={playing} size={28} /></button>
          <button className="icon-btn" aria-label="Next" onClick={() => player().next()}><Icon name="nextFill" size={22} /></button>
        </div>
      </div>
    </div>
  )
}

let root: Root | null = null

/** Pops the player out into an always-on-top mini window (Chrome/Edge Document Picture-in-Picture). */
export async function openPopOut() {
  const api = pipApi()
  if (!api) { toast('Pop-out player needs Chrome or Edge'); return }
  if (api.window) { api.window.focus(); return }
  const w = await api.requestWindow({ width: 340, height: 470 })
  // Bring the app's styles (and fonts) into the new window.
  for (const sheet of [...document.styleSheets]) {
    try {
      const css = [...sheet.cssRules].map((r) => r.cssText).join('\n')
      const style = w.document.createElement('style')
      style.textContent = css
      w.document.head.appendChild(style)
    } catch {
      if (sheet.href) {
        const link = w.document.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        w.document.head.appendChild(link)
      }
    }
  }
  w.document.documentElement.dataset.theme = 'dark'
  for (const v of ['--accent', '--on-accent', '--np-1', '--np-2', '--np-3', '--np-vivid']) {
    w.document.documentElement.style.setProperty(v, document.documentElement.style.getPropertyValue(v))
  }
  w.document.title = 'Arnav Music'
  const mount = w.document.createElement('div')
  w.document.body.appendChild(mount)
  root = createRoot(mount)
  root.render(<MiniWindow />)
  w.addEventListener('pagehide', () => { root?.unmount(); root = null })
}
