import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { trackRegistry } from './state/tracks'
import { useLibrary } from './state/library'
import { usePlayer } from './state/player'
import { useSettings } from './state/settings'
import { DEFAULT_PALETTE, extractPalette, type Palette } from './lib/color'
import { artworkFor } from './lib/classify'
import type { Track } from './lib/types'

export function useMediaQuery(q: string): boolean {
  const subscribe = (cb: () => void) => {
    const m = window.matchMedia(q)
    m.addEventListener('change', cb)
    return () => m.removeEventListener('change', cb)
  }
  return useSyncExternalStore(subscribe, () => window.matchMedia(q).matches, () => false)
}

export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)')

/** Re-renders when the track registry changes (new metadata arrived). */
export function useRegistryVersion(): number {
  return useSyncExternalStore(trackRegistry.subscribe, trackRegistry.version, trackRegistry.version)
}

/** Recently played tracks, newest first (consecutive repeats collapsed). */
export function useLiveHistory(limit = 50): { track: Track; at: number }[] {
  const events = useLibrary((s) => s.events)
  const v = useRegistryVersion()
  return useMemo(() => {
    const out: { track: Track; at: number }[] = []
    for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = events[i]
      if (e.deleted) continue
      const t = trackRegistry.get(e.trackId)
      if (!t) continue
      if (out.length && out[out.length - 1].track.id === t.id) continue
      out.push({ track: t, at: e.startedAt })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, v, limit])
}

/** Distinct recently played tracks, newest first. */
export function useRecentTracks(limit = 20): Track[] {
  const h = useLiveHistory(limit * 4)
  return useMemo(() => {
    const seen = new Set<string>()
    const out: Track[] = []
    for (const { track } of h) {
      if (seen.has(track.id)) continue
      seen.add(track.id)
      out.push(track)
      if (out.length >= limit) break
    }
    return out
  }, [h, limit])
}

/** Palette of the current song's artwork; applied to :root so the whole UI follows the music. */
export function useCurrentPalette(): Palette {
  const track = usePlayer((s) => s.queue[s.index]?.track ?? null)
  const [p, setP] = useState<Palette>(DEFAULT_PALETTE)
  useEffect(() => {
    let alive = true
    if (!track) { setP(DEFAULT_PALETTE); return }
    void extractPalette(artworkFor(track)).then((pal) => { if (alive) setP(pal) })
    return () => { alive = false }
  }, [track?.id, track])
  return p
}

export function usePaletteFor(url: string | null | undefined): Palette {
  const [p, setP] = useState<Palette>(DEFAULT_PALETTE)
  useEffect(() => {
    let alive = true
    void extractPalette(url).then((pal) => { if (alive) setP(pal) })
    return () => { alive = false }
  }, [url])
  return p
}

/**
 * Per-album colour theme: the cover's colours carried through the whole page (accent, links,
 * buttons, selection, row hovers and a deep tint), scoped to the page and undone on leave.
 */
export function usePageTheme(palette: Palette) {
  const accentMode = useSettings((s) => s.accentMode)
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.main-scroll')
    if (!el || palette === DEFAULT_PALETTE) return
    const vars: Record<string, string> = { '--page-1': palette.bg[0], '--page-2': palette.bg[1], '--page-vivid': palette.vivid }
    if (accentMode === 'artwork') { vars['--accent'] = palette.accent; vars['--on-accent'] = palette.onAccent }
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
    el.classList.add('themed')
    return () => {
      for (const k of Object.keys(vars)) el.style.removeProperty(k)
      el.classList.remove('themed')
    }
  }, [palette, accentMode])
}

/** Applies theme, glass, motion and accent to the document root. */
export function useThemeEffects(palette: Palette) {
  const { themeMode, glass, motion, accentMode, presetAccent, highContrast } = useSettings()
  const prefersLight = useMediaQuery('(prefers-color-scheme: light)')
  useEffect(() => {
    const root = document.documentElement
    const theme = themeMode === 'system' ? (prefersLight ? 'light' : 'dark') : themeMode
    root.dataset.theme = theme
    root.dataset.glass = glass ? 'on' : 'off'
    root.dataset.motion = motion
    root.dataset.contrast = highContrast ? 'high' : 'normal'
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f5f5f7' : '#060609')
  }, [themeMode, glass, motion, prefersLight, highContrast])
  useEffect(() => {
    const root = document.documentElement.style
    root.setProperty('--np-1', palette.bg[0])
    root.setProperty('--np-2', palette.bg[1])
    root.setProperty('--np-3', palette.bg[2])
    root.setProperty('--np-vivid', palette.vivid)
    const accent = accentMode === 'artwork' ? palette.accent : presetAccent
    root.setProperty('--accent', accent)
    root.setProperty('--on-accent', accentMode === 'artwork' ? palette.onAccent : '#0B0B0F')
  }, [palette, accentMode, presetAccent])
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Async loader with cancellation and error capture. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: unknown; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: null, loading: true })
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    fn().then(
      (data) => { if (alive) setState({ data, error: null, loading: false }) },
      (error) => { if (alive) setState((s) => ({ data: s.data, error, loading: false })) },
    )
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n])
  return { ...state, reload: () => setN((x) => x + 1) }
}
