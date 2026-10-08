/** Minimal typed wrapper around the official YouTube IFrame Player API. */

export interface YTPlayer {
  loadVideoById(opts: { videoId: string; startSeconds?: number }): void
  cueVideoById(opts: { videoId: string; startSeconds?: number }): void
  playVideo(): void
  pauseVideo(): void
  stopVideo?(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  setVolume(v: number): void
  getVolume(): number
  mute(): void
  unMute(): void
  isMuted(): boolean
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  getVideoLoadedFraction(): number
  setPlaybackRate(r: number): void
  getAvailablePlaybackRates(): number[]
  getVideoData?(): { video_id?: string; title?: string; author?: string }
  destroy(): void
  getIframe(): HTMLIFrameElement
}

interface YTNamespace {
  Player: new (el: HTMLElement | string, opts: {
    width?: string | number
    height?: string | number
    videoId?: string
    host?: string
    playerVars?: Record<string, string | number>
    events?: {
      onReady?: (e: { target: YTPlayer }) => void
      onStateChange?: (e: { data: number; target: YTPlayer }) => void
      onError?: (e: { data: number; target: YTPlayer }) => void
      onPlaybackRateChange?: (e: { data: number }) => void
      onAutoplayBlocked?: () => void
    }
  }) => YTPlayer
  PlayerState: { UNSTARTED: -1; ENDED: 0; PLAYING: 1; PAUSED: 2; BUFFERING: 3; CUED: 5 }
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

export const STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const

let apiPromise: Promise<YTNamespace> | null = null

export function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT)
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      prev?.()
      if (window.YT) resolve(window.YT)
    }
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    s.async = true
    s.onerror = () => {
      apiPromise = null
      reject(new Error('The YouTube player couldn’t load. Check your connection or content blockers.'))
    }
    document.head.appendChild(s)
  })
  return apiPromise
}

export function createPlayer(host: HTMLElement, handlers: {
  onReady: (p: YTPlayer) => void
  onState: (state: number) => void
  onError: (code: number) => void
  onAutoplayBlocked?: () => void
}): Promise<YTPlayer> {
  return loadYouTubeApi().then(
    (YT) =>
      new Promise((resolve) => {
        const mount = document.createElement('div')
        host.appendChild(mount)
        new YT.Player(mount, {
          width: '100%',
          height: '100%',
          host: 'https://www.youtube.com',
          playerVars: {
            controls: 0, disablekb: 1, playsinline: 1, rel: 0, iv_load_policy: 3, fs: 0, modestbranding: 1,
            enablejsapi: 1, origin: window.location.origin, widget_referrer: window.location.origin,
          },
          events: {
            onReady: (e) => { handlers.onReady(e.target); resolve(e.target) },
            onStateChange: (e) => handlers.onState(e.data),
            onError: (e) => handlers.onError(e.data),
            onAutoplayBlocked: () => handlers.onAutoplayBlocked?.(),
          },
        })
      }),
  )
}

/** YouTube error codes → whether another upload might play. */
export const UNPLAYABLE_CODES = new Set([2, 5, 100, 101, 150, 153])
export function errorCopy(code: number): string {
  if (code === 101 || code === 150 || code === 153) return 'The uploader doesn’t allow this video to play outside YouTube.'
  if (code === 100) return 'This video was removed or made private.'
  if (code === 2) return 'This video link isn’t valid.'
  return 'YouTube couldn’t play this video.'
}
