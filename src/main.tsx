import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { loadTracks, pruneRegistry } from './state/tracks'
import { usePlayer } from './state/player'
import { reloadForNewVersion } from './components/ErrorBoundary'
import { useLibrary } from './state/library'
import { startSync } from './services/sync'
import { startDj } from './services/dj'
import { useSettings } from './state/settings'
import { addKnownArtist, mergeSharedNames } from './lib/knownArtists'
import { fetchKnownNames } from './lib/meta'
import { pruneStaleCache } from './lib/youtube'
import './state/lyrics'
import './styles/global.css'
import './styles/components.css'
import './styles/shell.css'
import './styles/player.css'
import './styles/pages.css'
import './styles/social.css'
// Last: phone and detail polish that must win over the page styles.
import './styles/polish.css'

// A newer deploy replaced the code chunks this tab was using: reload once to pick them up.
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault()
  reloadForNewVersion()
})

async function boot() {
  // Library and track metadata load from IndexedDB before first paint of personal shelves.
  await Promise.all([loadTracks(), useLibrary.getState().load()])
  // One-time tidy of the track cache (keeps everything your library references).
  const s = useLibrary.getState()
  const referenced = new Set<string>([
    ...Object.keys(s.likes), ...Object.values(s.playlists).flatMap((p) => p.trackIds), ...s.events.map((e) => e.trackId),
    ...usePlayer.getState().queue.map((q) => q.track.id),
  ])
  pruneRegistry(referenced)
  void pruneStaleCache()
  // Back in your listening room after a reload.
  void import('./services/together').then((m) => m.rejoinAfterReload())
  void import('./services/social').then((m) => m.startSocial())
  // Diagnostics (read-only): window.__arnavLyricsProbe({ q: 'Kesariya Arijit Singh' })
  ;(window as unknown as { __arnavLyricsProbe: unknown }).__arnavLyricsProbe = async (i: { q?: string; v?: string }) => (await import('./services/lyricsProbe')).lyricsProbe(i)
  // Names every visitor's YouTube Topic results taught the server (artists, films).
  void fetchKnownNames().then((r) => { if (r) mergeSharedNames(r) })
  startSync()
  for (const a of useSettings.getState().seedArtists) addKnownArtist(a)
  startDj()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )
  document.getElementById('boot')?.classList.add('done')
  setTimeout(() => document.getElementById('boot')?.remove(), 700)
}

void boot()
