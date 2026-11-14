import { Component, type ReactNode } from 'react'
import { reportError } from '../lib/report'
import { Icon } from './Icon'

const RELOAD_KEY = 'arnav.chunkReload'

/** A page failed to load because a newer version was deployed: reload once to pick it up. */
export function isStaleChunk(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Expected a JavaScript-or-Wasm module/i.test(msg)
}

export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < 30_000) return false // don't loop
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch { /* storage blocked: still try once */ }
  location.reload()
  return true
}

/** Keeps a page crash inside the page: the player, queue and navigation keep working. */
export class PageBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: unknown }> {
  state: { error: unknown } = { error: null }
  static getDerivedStateFromError(error: unknown) { return { error } }
  componentDidCatch(error: unknown) {
    if (isStaleChunk(error)) reloadForNewVersion()
    else { console.error('[Arnav Music] page error', error); reportError('page', error) }
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (!this.state.error) return this.props.children
    const stale = isStaleChunk(this.state.error)
    return (
      <div className="page">
        <div className="empty">
          <div className="empty-icon"><Icon name={stale ? 'sync' : 'info'} size={26} /></div>
          <div className="t-title">{stale ? 'Arnav Music was just updated' : 'This page hit a snag'}</div>
          <div className="t-sub">{stale ? 'Reload to get the newest version — your music keeps playing until you do.' : 'Your music is still playing. Try again, or head home.'}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
            {!stale && <button className="btn btn-secondary" onClick={() => this.setState({ error: null })}>Try again</button>}
          </div>
        </div>
      </div>
    )
  }
}

/**
 * Around an overlay (Now Playing, the dock, menus…): if it crashes it disappears quietly and the
 * rest of the app keeps working. It tries again when `resetKey` changes (the next song, say).
 */
export class QuietBoundary extends Component<{ children: ReactNode; name: string; resetKey?: string }, { error: unknown }> {
  state: { error: unknown } = { error: null }
  static getDerivedStateFromError(error: unknown) { return { error } }
  componentDidCatch(error: unknown) {
    if (isStaleChunk(error)) reloadForNewVersion()
    else { console.error(`[Arnav Music] ${this.props.name} error`, error); reportError(this.props.name, error) }
  }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() { return this.state.error ? null : this.props.children }
}

/** The last line: a crash anywhere else shows a calm screen with Reload instead of a blank page. */
export class RootBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null }
  static getDerivedStateFromError(error: unknown) { return { error } }
  componentDidCatch(error: unknown) {
    if (isStaleChunk(error)) reloadForNewVersion()
    else { console.error('[Arnav Music] app error', error); reportError('app', error) }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="center" style={{ height: '100dvh', flexDirection: 'column', gap: 12, padding: 24, textAlign: 'center' }} role="alert">
        <div className="t-title">Arnav Music hit a snag</div>
        <div className="t-sub" style={{ maxWidth: 420 }}>Your library and settings are safe on this device. Reloading usually fixes it.</div>
        <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}
