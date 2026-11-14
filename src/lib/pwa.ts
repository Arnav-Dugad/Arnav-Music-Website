import { create } from 'zustand'
import { toast } from '../state/ui'

/**
 * Installable app: the service worker (offline start, saved artwork), "update ready", the install
 * prompt, and the unread badge on the app icon.
 */
interface InstallPromptEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

interface PwaState {
  /** The browser offered installing (Chrome, Edge, Android): Settings shows an Install button. */
  canInstall: boolean
  /** Running as the installed app. */
  installed: boolean
  /** A new version is downloaded and waiting. */
  updateReady: boolean
}
export const usePwa = create<PwaState>()(() => ({
  canInstall: false,
  installed: typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true),
  updateReady: false,
}))

let deferred: InstallPromptEvent | null = null
let waiting: ServiceWorker | null = null
let reloading = false

/** Shows the browser's install dialog. Returns true when the app was installed. */
export async function installApp(): Promise<boolean> {
  if (!deferred) return false
  const e = deferred
  deferred = null
  usePwa.setState({ canInstall: false })
  await e.prompt()
  return (await e.userChoice).outcome === 'accepted'
}

/** iPhone and iPad Safari never offer the prompt: Settings explains Share → Add to Home Screen. */
export const isIosSafari = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** Swaps to the waiting version and reloads once it takes over. */
export function applyUpdate() {
  if (!waiting) { location.reload(); return }
  reloading = true
  waiting.postMessage('skip-waiting')
}

function offerUpdate(sw: ServiceWorker) {
  waiting = sw
  usePwa.setState({ updateReady: true })
  toast('New version ready', { label: 'Reload', run: applyUpdate })
}

export function startPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    usePwa.setState({ canInstall: true })
  })
  window.addEventListener('appinstalled', () => { deferred = null; usePwa.setState({ canInstall: false, installed: true }) })

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload()
  })
  const register = async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
      // A version that finished downloading while this tab was closed.
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting)
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing
        sw?.addEventListener('statechange', () => {
          // Installed with a page already controlled: an update (the very first install isn't).
          if (sw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(sw)
        })
      })
      // Long-lived tabs check for a new deploy now and then, and when you come back to them.
      setInterval(() => { void reg.update().catch(() => undefined) }, 60 * 60_000)
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void reg.update().catch(() => undefined) })
    } catch { /* private mode or blocked: the app works without it */ }
  }
  if (document.readyState === 'complete') void register()
  else window.addEventListener('load', () => void register(), { once: true })
}

/** The unread count (friend requests + songs sent to you) on the installed app's icon. */
export function setAppBadge(n: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> }
  if (!nav.setAppBadge) return
  void (n > 0 ? nav.setAppBadge(n) : nav.clearAppBadge?.())?.catch(() => undefined)
}
