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
