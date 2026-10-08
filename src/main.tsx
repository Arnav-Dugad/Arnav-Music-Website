import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { loadTracks } from './state/tracks'
import { useLibrary } from './state/library'
import { startSync } from './services/sync'
import './state/lyrics'
import './styles/global.css'
import './styles/components.css'
import './styles/shell.css'
import './styles/player.css'
import './styles/pages.css'

async function boot() {
  // Library and track metadata load from IndexedDB before first paint of personal shelves.
  await Promise.all([loadTracks(), useLibrary.getState().load()])
  startSync()
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
