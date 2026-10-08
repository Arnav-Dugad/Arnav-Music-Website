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
  sidebarCollapsed: false,
  pushToast(t) {
    const id = ++seq
    set({ toasts: [...get().toasts.slice(-2), { ...t, id }] })
    setTimeout(() => get().dismiss(id), t.action ? 6000 : 3200)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
  set: (p) => set(p),
}))

export const toast = (text: string, action?: Toast['action']) => useUi.getState().pushToast({ text, action })
export const ui = () => useUi.getState()
