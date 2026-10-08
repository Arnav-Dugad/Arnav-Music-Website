import { useEffect, useRef } from 'react'
import { startController } from './controller'

/**
 * Two official YouTube players ("decks") for gapless playback and crossfades. Neither is ever
 * re-parented (that would reload it); the active deck glides over whichever "slot" element is
 * visible (Now Playing in Video mode) and otherwise parks out of sight while audio keeps playing.
 * During a crossfade both decks sit in the slot and the outgoing video fades away.
 */
const slots: HTMLElement[] = []
const hosts: (HTMLDivElement | null)[] = [null, null]
let active = 0
/** 0..1 while a crossfade runs: how far the incoming deck has faded in. */
let mix: number | null = null
let raf = 0

const PARKED = 'position:fixed;right:0;bottom:0;width:160px;height:90px;z-index:-1;opacity:0.001;pointer-events:none;overflow:hidden;'

function place() {
  raf = 0
  const slot = slots[slots.length - 1]
  const visible = slot && slot.isConnected
  const r = visible ? slot.getBoundingClientRect() : null
  const style = visible ? getComputedStyle(slot) : null
  hosts.forEach((host, i) => {
    if (!host) return
    const isActive = i === active
    const fading = mix != null && !isActive
    if (r && style && (isActive || fading)) {
      const op = Number(style.opacity) * (fading ? 1 - (mix ?? 0) : 1)
      host.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;z-index:${fading ? 66 : 65};opacity:${op};border-radius:${style.borderRadius};overflow:hidden;pointer-events:none;box-shadow:0 30px 80px rgba(0,0,0,.5);background:#000;`
    } else host.style.cssText = PARKED
  })
  if (visible || mix != null) raf = requestAnimationFrame(place)
}
const schedule = () => { if (!raf) raf = requestAnimationFrame(place) }

/** Which deck is playing the current song, and how far a crossfade has come. */
export function setDeckView(deck: number, crossfade: number | null) {
  active = deck
  mix = crossfade
  schedule()
}

export function registerSlot(el: HTMLElement) {
  slots.push(el)
  schedule()
  return () => {
    const i = slots.indexOf(el)
    if (i >= 0) slots.splice(i, 1)
    schedule()
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
  const a = useRef<HTMLDivElement>(null)
  const b = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!a.current || !b.current) return
    hosts[0] = a.current
    hosts[1] = b.current
    place()
    void startController(a.current, b.current)
  }, [])
  return (
    <>
      <div ref={a} id="yt-host" aria-hidden="true" />
      <div ref={b} id="yt-host-b" aria-hidden="true" />
    </>
  )
}
