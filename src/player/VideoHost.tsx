import { useEffect, useRef } from 'react'
import { startController } from './controller'

/**
 * One official YouTube player for the whole app. It is never re-parented (that would reload it);
 * instead it glides over whichever "slot" element is visible (Now Playing in Video mode), and
 * otherwise parks out of sight while audio keeps playing.
 */
const slots: HTMLElement[] = []
let hostEl: HTMLDivElement | null = null
let raf = 0

function place() {
  raf = 0
  const host = hostEl
  if (!host) return
  const slot = slots[slots.length - 1]
  if (slot && slot.isConnected) {
    const r = slot.getBoundingClientRect()
    const style = getComputedStyle(slot)
    host.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:65;opacity:${style.opacity};border-radius:${style.borderRadius};overflow:hidden;pointer-events:none;box-shadow:0 30px 80px rgba(0,0,0,.5);background:#000;`
    raf = requestAnimationFrame(place)
  } else {
    host.style.cssText = 'position:fixed;right:0;bottom:0;width:160px;height:90px;z-index:-1;opacity:0.001;pointer-events:none;overflow:hidden;'
  }
}

export function registerSlot(el: HTMLElement) {
  slots.push(el)
  if (!raf) raf = requestAnimationFrame(place)
  return () => {
    const i = slots.indexOf(el)
    if (i >= 0) slots.splice(i, 1)
    if (!raf) raf = requestAnimationFrame(place)
  }
}

export function useVideoSlot<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!ref.current) return
    return registerSlot(ref.current)
  }, [])
  return ref
}

export function VideoHost() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    hostEl = ref.current
    place()
    void startController(ref.current)
  }, [])
  return <div ref={ref} id="yt-host" aria-hidden="true" />
}
