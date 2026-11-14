import { useEffect, useRef, type RefObject } from 'react'

/**
 * Dialog behaviour every sheet and overlay shares:
 * - focus moves into the dialog when it opens and back to what you were on when it closes;
 * - Tab and Shift+Tab stay inside it;
 * - Escape closes only the topmost dialog (one press, one layer);
 * - optionally, the rest of the app is `inert` (screen readers and Tab skip it) while it's open.
 */
const stack: { id: symbol; blocks: boolean }[] = []
let inertCount = 0

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
}

function setAppInert(on: boolean) {
  inertCount = Math.max(0, inertCount + (on ? 1 : -1))
  const app = document.getElementById('root')
  if (app) app.inert = inertCount > 0
}

export function useDialog(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void, opts: { inertApp?: boolean; initialFocus?: 'first' | 'container'; blocksShortcuts?: boolean } = {}) {
  const close = useRef(onClose)
  close.current = onClose
  const { inertApp = false, initialFocus = 'first', blocksShortcuts = true } = opts
  useEffect(() => {
    if (!open) return
    const id = Symbol('dialog')
    stack.push({ id, blocks: blocksShortcuts })
    const before = document.activeElement as HTMLElement | null
    if (inertApp) setAppInert(true)
    // After the enter animation's first frame, so the dialog is in the DOM and visible.
    const t = requestAnimationFrame(() => {
      const el = ref.current
      if (!el || el.contains(document.activeElement)) return
      const autofocus = el.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
      const first = initialFocus === 'first' ? autofocus ?? focusables(el).find((f) => !f.matches('[aria-label="Close"]')) ?? focusables(el)[0] : null
      if (first) first.focus({ preventScroll: true })
      else { if (!el.hasAttribute('tabindex')) el.tabIndex = -1; el.focus({ preventScroll: true }) }
    })
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1]?.id !== id) return
      const el = ref.current
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); return }
      if (e.key !== 'Tab' || !el) return
      const items = focusables(el)
      if (!items.length) { e.preventDefault(); return }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (!active || !el.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(t)
      window.removeEventListener('keydown', onKey, true)
      const i = stack.findIndex((d) => d.id === id)
      if (i >= 0) stack.splice(i, 1)
      if (inertApp) setAppInert(false)
      // Back to where you were, if it's still there.
      if (before && before.isConnected && typeof before.focus === 'function') before.focus({ preventScroll: true })
    }
  }, [open, ref, inertApp, initialFocus, blocksShortcuts])
}

/**
 * True while a dialog that owns the keyboard is open (sheets, menus): single-key shortcuts stay
 * quiet underneath. Now Playing and Cinematic lyrics keep them (Space, arrows, L…).
 */
export const dialogOpen = () => stack.some((d) => d.blocks)
