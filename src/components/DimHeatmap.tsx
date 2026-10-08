import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Segmented, Spinner } from './ui'
import { idbGet } from '../lib/idb'
import { fetchCredits, type CreditsResult, type ItunesItem } from '../lib/meta'
import { monthKey } from '../lib/wrapped'
import type { PlayEvent, Track } from '../lib/types'
import { trackRegistry } from '../state/tracks'

type Dim = 'film' | 'era' | 'composer'
const ROWS = 8

function lastMonths(n: number, now = Date.now()): string[] {
  const d = new Date(now)
  return Array.from({ length: n }, (_, i) => monthKey(new Date(d.getFullYear(), d.getMonth() - (n - 1 - i), 1).getTime()))
}
const monthShort = (k: string) => new Date(Number(k.slice(0, 4)), Number(k.slice(5)) - 1, 1).toLocaleDateString(undefined, { month: 'short' })

/** Per song: release year (Apple Music / upload year) and composers (credits), from local caches. */
async function readFacts(tracks: Track[]): Promise<Map<string, { year: number | null; composers: string[] }>> {
  const out = new Map<string, { year: number | null; composers: string[] }>()
  await Promise.all(tracks.map(async (t) => {
    const [it, cr] = await Promise.all([
      idbGet<{ item: ItunesItem | null }>(`itm|v3|${t.id}`, 'cache'),
      idbGet<{ r: CreditsResult }>(`cr|v4|${t.playbackRef}`, 'cache'),
    ])
    const year = it?.item?.releaseDate ? Number(it.item.releaseDate.slice(0, 4)) : cr?.r.film?.year ?? t.year ?? null
    const composers = (cr?.r.entries ?? []).filter((e) => e.group === 'WRITTEN' && /composer|music director/i.test(e.role)).map((e) => e.name).slice(0, 2)
    out.set(t.id, { year, composers })
  }))
  return out
}

/**
 * Your listening history as a heatmap by film / album, era (decade of release) or composer:
 * rows are your top values, columns the last 12 months, colour the minutes (one hue, light → dark).
 */
export function DimHeatmap({ events }: { events: PlayEvent[] }) {
  const nav = useNavigate()
  const [dim, setDim] = useState<Dim>('film')
  const [facts, setFacts] = useState<Map<string, { year: number | null; composers: string[] }> | null>(null)
  const [hover, setHover] = useState<{ row: string; month: string; minutes: number } | null>(null)
  const [table, setTable] = useState(false)
  const [filling, setFilling] = useState<number | null>(null)
  const months = useMemo(() => lastMonths(12), [])
  const since = useMemo(() => new Date(Number(months[0].slice(0, 4)), Number(months[0].slice(5)) - 1, 1).getTime(), [months])
  const recent = useMemo(() => events.filter((e) => e.startedAt >= since), [events, since])
  const tracks = useMemo(() => {
    const ids = [...new Set(recent.map((e) => e.trackId))]
    return trackRegistry.many(ids)
  }, [recent])
  const [nonce, setNonce] = useState(0)
  useEffect(() => { void readFacts(tracks).then(setFacts) }, [tracks, nonce])

  const grid = useMemo(() => {
    const rows = new Map<string, { label: string; total: number; cells: Map<string, number>; href?: string }>()
    const add = (key: string, label: string, month: string, ms: number, href?: string) => {
      const r = rows.get(key) ?? { label, total: 0, cells: new Map(), href }
      r.total += ms
      r.cells.set(month, (r.cells.get(month) ?? 0) + ms)
      rows.set(key, r)
    }
    for (const e of recent) {
      const t = trackRegistry.get(e.trackId)
      if (!t) continue
      const m = monthKey(e.startedAt)
      if (dim === 'film' && t.album) add(t.album.toLowerCase(), t.album, m, e.listenedMs, `/album/${encodeURIComponent(t.album)}?a=${encodeURIComponent(t.artist)}`)
      if (dim === 'era') {
        const y = facts?.get(t.id)?.year ?? t.year
        if (y && y > 1900) { const dec = Math.floor(y / 10) * 10; add(String(dec), `${dec}s`, m, e.listenedMs) }
      }
      if (dim === 'composer') for (const c of facts?.get(t.id)?.composers ?? []) add(c.toLowerCase(), c, m, e.listenedMs, `/artist/${encodeURIComponent(c)}`)
    }
    const list = [...rows.values()].sort((a, b) => (dim === 'era' ? Number(b.label.slice(0, 4)) - Number(a.label.slice(0, 4)) : b.total - a.total)).slice(0, ROWS)
    const max = Math.max(1, ...list.flatMap((r) => [...r.cells.values()]))
    return { list, max }
  }, [recent, dim, facts])

  const missingComposers = dim === 'composer' && facts ? tracks.filter((t) => t.id.startsWith('yt:') && !(facts.get(t.id)?.composers.length)).length : 0
  const fill = async () => {
    // Your most-played songs first; each credits lookup is cached for everyone.
    const counts = new Map<string, number>()
    for (const e of recent) counts.set(e.trackId, (counts.get(e.trackId) ?? 0) + e.listenedMs)
    const todo = tracks.filter((t) => t.id.startsWith('yt:') && !(facts?.get(t.id)?.composers.length)).sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)).slice(0, 25)
    for (let i = 0; i < todo.length; i++) {
      setFilling(i / todo.length)
      await fetchCredits(todo[i]).catch(() => null)
    }
    setFilling(null)
    setNonce((n) => n + 1)
  }

  const level = (ms: number) => (ms <= 0 ? 0 : 0.18 + 0.82 * Math.sqrt(ms / grid.max))
  return (
    <div className="dimheat">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <Segmented id="dimheat" size="sm" value={dim} onChange={setDim} options={[{ value: 'film', label: 'Film & album' }, { value: 'era', label: 'Era' }, { value: 'composer', label: 'Composer' }]} />
        <div className="row" style={{ gap: 8 }}>
          {dim === 'composer' && missingComposers > 0 && (
            <button className="chip" disabled={filling != null} onClick={() => void fill()}>{filling != null ? <><Spinner size={13} /> {Math.round(filling * 100)}%</> : `Find composers for ${Math.min(25, missingComposers)} songs`}</button>
          )}
          <button className={`chip ${table ? 'on' : ''}`} onClick={() => setTable((x) => !x)}>{table ? 'Chart' : 'Table'}</button>
        </div>
      </div>
      {!grid.list.length ? (
        <div className="t-sub" style={{ padding: '18px 0' }}>{dim === 'composer' ? 'No composers known yet for what you played — find them from the songs’ credits.' : dim === 'era' ? 'Release years appear as songs are matched to their albums.' : 'Play songs from albums and films to see them here.'}</div>
      ) : table ? (
        <div className="dimheat-table-wrap">
          <table className="dimheat-table">
            <thead><tr><th scope="col">{dim === 'era' ? 'Era' : dim === 'composer' ? 'Composer' : 'Film / album'}</th>{months.map((m) => <th key={m} scope="col">{monthShort(m)}</th>)}<th scope="col">Total</th></tr></thead>
            <tbody>{grid.list.map((r) => <tr key={r.label}><th scope="row">{r.label}</th>{months.map((m) => <td key={m}>{Math.round((r.cells.get(m) ?? 0) / 60_000) || ''}</td>)}<td>{Math.round(r.total / 60_000)}</td></tr>)}</tbody>
          </table>
          <div className="t-caption">Minutes per month.</div>
        </div>
      ) : (
        <div className="dimheat-grid" style={{ ['--cols' as string]: months.length }} onPointerLeave={() => setHover(null)}>
          <span />
          {months.map((m) => <span key={m} className="dimheat-col">{monthShort(m)}</span>)}
          {grid.list.map((r) => (
            <div key={r.label} className="dimheat-row">
              <button className="dimheat-label ellipsis link" disabled={!r.href} onClick={() => r.href && nav(r.href)} title={r.label}>{r.label}</button>
              {months.map((m) => {
                const ms = r.cells.get(m) ?? 0
                return <span key={m} className="dimheat-cell" style={{ ['--l' as string]: level(ms) }} onPointerEnter={() => setHover({ row: r.label, month: m, minutes: Math.round(ms / 60_000) })} aria-label={`${r.label}, ${monthShort(m)}: ${Math.round(ms / 60_000)} minutes`} />
              })}
            </div>
          ))}
          <div className="dimheat-foot">
            <span className="t-caption">{hover ? <><b>{hover.row}</b> · {monthShort(hover.month)} · {hover.minutes} min</> : 'Hover a cell for minutes'}</span>
            <span className="dimheat-legend t-caption">Less {[0.18, 0.4, 0.62, 0.82, 1].map((l) => <i key={l} style={{ ['--l' as string]: l }} />)} More</span>
          </div>
        </div>
      )}
    </div>
  )
}
