import { settings, useSettings, type ThemeMode } from '../state/settings'

/** Where the last press happened — the circle grows from there. */
let lastX = typeof window !== 'undefined' ? window.innerWidth / 2 : 0
let lastY = typeof window !== 'undefined' ? window.innerHeight / 2 : 0
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', (e) => { lastX = e.clientX; lastY = e.clientY }, { capture: true, passive: true })
}

const resolve = (mode: ThemeMode) =>
  mode === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode

/**
 * Changes the theme with a circular reveal that expands from the pointer (View Transitions API).
 * Falls back to an instant change where unsupported or when motion is reduced.
 */
export function setThemeWithReveal(mode: ThemeMode) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } }
  const apply = () => {
    document.documentElement.dataset.theme = resolve(mode)
    useSettings.getState().update({ themeMode: mode })
  }
  if (!doc.startViewTransition || settings().motion !== 'full' || resolve(mode) === document.documentElement.dataset.theme) { apply(); return }
  const r = Math.hypot(Math.max(lastX, innerWidth - lastX), Math.max(lastY, innerHeight - lastY))
  const t = doc.startViewTransition(apply)
  void t.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${lastX}px ${lastY}px)`, `circle(${r}px at ${lastX}px ${lastY}px)`] },
      { duration: 650, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', pseudoElement: '::view-transition-new(root)' },
    )
  }).catch(() => undefined)
}

type VT = { finished: Promise<void>; ready: Promise<void> }
type VTDoc = Document & { startViewTransition?: (cb: () => void | Promise<void>) => VT }

/**
 * Shared-element morph: the tapped cover flies into the next page's hero cover (any element named
 * `view-transition-name: cover`). [run] performs the navigation. Falls back to a plain navigation.
 */
export function morphTo(from: HTMLElement | null, run: () => void) {
  const doc = document as VTDoc
  if (!from || !doc.startViewTransition || settings().motion !== 'full') { run(); return }
  const root = document.documentElement
  from.style.setProperty('view-transition-name', 'cover')
  root.classList.add('vt-morph')
  const t = doc.startViewTransition(async () => {
    from.style.removeProperty('view-transition-name')
    const before = new Set(document.querySelectorAll('.hero-cover, .artist-avatar'))
    run()
    // Wait for the next page's hero (after the old page's exit; maybe a lazy chunk), briefly.
    const until = performance.now() + 900
    await new Promise<void>((resolve) => {
      const check = () => {
        const fresh = [...document.querySelectorAll('.hero-cover, .artist-avatar')].some((el) => !before.has(el))
        if (fresh || performance.now() > until) resolve()
        else requestAnimationFrame(check)
      }
      requestAnimationFrame(check)
    })
  })
  void t.finished.catch(() => undefined).finally(() => { root.classList.remove('vt-morph'); from.style.removeProperty('view-transition-name') })
}

/** True while a cover morph runs (pages skip their own cover entrance so the morph lands). */
export const isMorphing = () => typeof document !== 'undefined' && document.documentElement.classList.contains('vt-morph')
