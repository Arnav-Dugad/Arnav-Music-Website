import { create } from 'zustand'
import type { Track } from '../lib/types'

export interface Toast { id: number; text: string; action?: { label: string; run: () => void } }

export interface MenuState {
  track: Track
  x: number
  y: number
  /** Extra context, e.g. removing from a playlist. */
  playlistId?: string
  queueKey?: string
}

interface UiState {
  toasts: Toast[]
  palette: boolean
  menu: MenuState | null
  addTo: Track[] | null
  authOpen: boolean
  shortcutsOpen: boolean
  phoneOpen: boolean
  sidebarCollapsed: boolean
  pushToast: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
  set: (p: Partial<Omit<UiState, 'set' | 'pushToast' | 'dismiss'>>) => void
}

let seq = 0
export const useUi = create<UiState>()((set, get) => ({
  toasts: [],
  palette: false,
  menu: null,
  addTo: null,
  authOpen: false,
  shortcutsOpen: false,
  phoneOpen: false,
  sidebarCollapsed: false,
  pushToast(t) {
    const id = ++seq
    set({ toasts: [...get().toasts.slice(-2), { ...t, id }] })
    toastTimers.set(id, setTimeout(() => get().dismiss(id), t.action ? 6000 : 3200))
  },
  dismiss: (id) => { clearTimeout(toastTimers.get(id)); toastTimers.delete(id); set({ toasts: get().toasts.filter((x) => x.id !== id) }) },
  set: (p) => set(p),
}))

const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
/** Hovering or focusing a toast holds it; leaving gives a little time to read the rest. */
export function holdToast(id: number, hold: boolean) {
  clearTimeout(toastTimers.get(id))
  if (!hold) toastTimers.set(id, setTimeout(() => useUi.getState().dismiss(id), 2500))
}

export const toast = (text: string, action?: Toast['action']) => useUi.getState().pushToast({ text, action })
export const ui = () => useUi.getState()
