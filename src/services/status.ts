import { create } from 'zustand'
import { health, setServerWithoutKey } from '../lib/youtube'
import { useSettings } from '../state/settings'

interface ApiStatus {
  checked: boolean
  reachable: boolean
  serverKey: boolean
  check: () => Promise<void>
}

/** Whether the edge API is reachable and has a YouTube key (else the listener can paste their own). */
export const useApiStatus = create<ApiStatus>()((set) => ({
  checked: false,
  reachable: true,
  serverKey: true,
  async check() {
    const h = await health()
    setServerWithoutKey(!!h && !h.youtube)
    set({ checked: true, reachable: !!h, serverKey: !!h?.youtube })
  },
}))

void useApiStatus.getState().check()

export function useYoutubeReady(): { ready: boolean; checked: boolean; reason: 'ok' | 'noKey' | 'noApi' } {
  const { checked, reachable, serverKey } = useApiStatus()
  const userKey = useSettings((s) => s.youtubeKey.trim().length > 0)
  if (!checked) return { ready: true, checked, reason: 'ok' }
  if (!reachable) return { ready: false, checked, reason: 'noApi' }
  if (!serverKey && !userKey) return { ready: false, checked, reason: 'noKey' }
  return { ready: true, checked, reason: 'ok' }
}
