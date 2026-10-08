/** Port of QueryNormalizer: "  Daft PUNK!! " and "daft punk" share one cache entry. */
const noise = new Set(['official', 'video', 'audio', 'lyrics', 'lyric', 'hd', '4k', 'mv'])
export const MIN_REMOTE_LENGTH = 2
export const DEBOUNCE_MS = 650

export function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}+/gu, '')
    .replace(/[^\p{L}\p{N}\s&']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function cacheKey(raw: string, filter = 'all'): string {
  const tokens = normalize(raw).split(' ').filter((t) => t && !noise.has(t))
  return `${filter}|${tokens.join(' ')}`
}

export function isRemoteWorthy(raw: string): boolean {
  const n = normalize(raw)
  return n.length >= MIN_REMOTE_LENGTH && /[\p{L}\p{N}]/u.test(n)
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2 || a.length > 80 || b.length > 80) return 99
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

/** Local fuzzy match score 0..1 used for instant suggestions from cache/library. */
export function matchScore(query: string, candidate: string): number {
  const q = normalize(query)
  const c = normalize(candidate)
  if (!q || !c) return 0
  if (c === q) return 1
  if (c.startsWith(q)) return 0.9
  const words = c.split(' ')
  if (words.some((w) => w.startsWith(q))) return 0.75
  if (c.includes(q)) return 0.6
  const qt = q.split(' ').filter(Boolean)
  const hits = qt.filter((t) => words.some((w) => w.startsWith(t))).length
  const prefix = qt.length ? (0.5 * hits) / qt.length : 0
  const fuzzyHits = qt.filter((t) => t.length >= 4 && words.some((w) => editDistance(t, w) <= (t.length >= 8 ? 2 : 1))).length
  return Math.max(prefix, qt.length && fuzzyHits === qt.length ? 0.55 : 0)
}
