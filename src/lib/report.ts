/**
 * Crash reports from the field: an error anywhere in the app is sent (once per kind, at most ten a
 * visit) to /api/log, which writes it to the Cloudflare logs. Sent: the error, the page path and the
 * browser. Never your account, library, searches or anything you listened to.
 */
const sent = new Set<string>()
const NOISE = /ResizeObserver loop|Script error\.?$|chrome-extension:|moz-extension:|safari-extension:|Failed to fetch|NetworkError|Load failed|AbortError|The user aborted/i

export function reportError(where: string, error: unknown) {
  try {
    if (!import.meta.env.PROD) return
    const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error)?.slice(0, 300) ?? 'unknown')
    const message = `${e.name}: ${e.message}`.slice(0, 300)
    const stack = (e.stack ?? '').split('\n').slice(0, 8).join('\n').slice(0, 1500)
    if (NOISE.test(message) || NOISE.test(stack)) return
    const key = `${where}|${message}`
    if (sent.has(key) || sent.size >= 10) return
    sent.add(key)
    const body = JSON.stringify({ where, message, stack, path: location.pathname, ua: navigator.userAgent.slice(0, 160), at: Date.now() })
    if (!navigator.sendBeacon?.('/api/log', new Blob([body], { type: 'application/json' }))) {
      void fetch('/api/log', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => undefined)
    }
  } catch { /* reporting must never throw */ }
}

export function startErrorReports() {
  window.addEventListener('error', (e) => reportError('window', e.error ?? e.message))
  window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason))
}
