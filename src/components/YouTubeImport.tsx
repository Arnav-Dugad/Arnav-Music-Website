import { useState } from 'react'
import { Sheet, Spinner, Artwork, Notice } from './ui'
import { Icon } from './Icon'
import { youtubeAccessToken, authMessage } from '../lib/firebase'
import { bestThumb, videoToTrack, type YtSnippet, type YtVideo } from '../lib/classify'
import { decodeEntities } from '../lib/format'
import { useLibrary, lib } from '../state/library'
import { remember } from '../state/tracks'
import { toast } from '../state/ui'

interface RemoteList { id: string; title: string; count: number; art?: string }

async function gapi<T>(path: string, token: string, params: Record<string, string>): Promise<T> {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `YouTube error ${r.status}`)
  }
  return r.json() as Promise<T>
}

/** Import from YouTube: copies your playlists and Liked videos into Arnav playlists (read-only access). */
export function YouTubeImport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [token, setToken] = useState<string | null>(null)
  const [lists, setLists] = useState<RemoteList[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connect = async () => {
    setBusy(true); setError(null)
    try {
      const t = await youtubeAccessToken()
      setToken(t)
      const out: RemoteList[] = [{ id: 'LL', title: 'Liked videos', count: 0 }]
      let page: string | undefined
      for (let i = 0; i < 5; i++) {
        const r = await gapi<{ items?: { id: string; snippet?: YtSnippet; contentDetails?: { itemCount?: number } }[]; nextPageToken?: string }>('playlists', t, { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...(page ? { pageToken: page } : {}) })
        out.push(...(r.items ?? []).map((p) => ({ id: p.id, title: decodeEntities(p.snippet?.title ?? 'Playlist'), count: p.contentDetails?.itemCount ?? 0, art: bestThumb(p.snippet?.thumbnails) })))
        page = r.nextPageToken
        if (!page) break
      }
      setLists(out)
      setPicked(new Set(out.map((l) => l.id)))
    } catch (e) {
      setError(authMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    if (!token || !lists) return
    setBusy(true); setError(null)
    const chosen = lists.filter((l) => picked.has(l.id))
    let imported = 0
    try {
      for (let li = 0; li < chosen.length; li++) {
        const l = chosen[li]
        setProgress({ done: li, total: chosen.length, label: l.title })
        const ids: string[] = []
        let page: string | undefined
        for (let i = 0; i < 20; i++) {
          const r = await gapi<{ items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string }>('playlistItems', token, { part: 'contentDetails', playlistId: l.id, maxResults: '50', ...(page ? { pageToken: page } : {}) })
          ids.push(...(r.items ?? []).map((x) => x.contentDetails?.videoId).filter((v): v is string => !!v))
          page = r.nextPageToken
          if (!page) break
        }
        const tracks = []
        for (let i = 0; i < ids.length; i += 50) {
          const r = await gapi<{ items?: YtVideo[] }>('videos', token, { part: 'snippet,contentDetails,status', id: ids.slice(i, i + 50).join(',') })
          tracks.push(...(r.items ?? []).filter((v) => v.status?.embeddable !== false).map(videoToTrack))
        }
        remember(tracks)
        const id = `ytimp_${l.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 56)}`
        const existing = useLibrary.getState().playlists[id]
        if (existing && !existing.deleted) {
          lib().reorderPlaylist(id, [...new Set([...tracks.map((t) => t.id)])])
        } else {
          useLibrary.getState().applyRemote({
            playlists: {
              ...useLibrary.getState().playlists,
              [id]: { id, name: l.title.slice(0, 100), description: 'Imported from YouTube', kind: 'ARNAV', artworkUrl: null, trackIds: tracks.map((t) => t.id), createdAt: Date.now(), updatedAt: Date.now(), pinned: false, dirty: true, remoteRef: l.id },
            },
          })
        }
        imported++
      }
      setProgress({ done: chosen.length, total: chosen.length, label: 'Done' })
      toast(`Imported ${imported} ${imported === 1 ? 'playlist' : 'playlists'} from YouTube`)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <Sheet open={open} onClose={() => { if (!busy) onClose() }} title="Import from YouTube" width={520}>
      {!lists ? (
        <div className="col" style={{ gap: 14 }}>
          <div className="t-sub">Copies your YouTube playlists and Liked videos into Arnav playlists. Arnav Music asks for read-only access; the token stays in this tab’s memory and is never stored.</div>
          {error && <Notice tone="error">{error}</Notice>}
          <button className="btn btn-primary btn-lg" disabled={busy} onClick={() => void connect()}>{busy ? <Spinner /> : <Icon name="youtube" size={18} />} Connect YouTube</button>
        </div>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="t-sub">{picked.size} of {lists.length} selected</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setPicked(picked.size === lists.length ? new Set() : new Set(lists.map((l) => l.id)))}>{picked.size === lists.length ? 'Select none' : 'Select all'}</button>
          </div>
          <div className="col" style={{ gap: 2, maxHeight: '46vh', overflowY: 'auto' }}>
            {lists.map((l) => (
              <button key={l.id} className="menu-item" style={{ height: 56 }} onClick={() => { const n = new Set(picked); if (n.has(l.id)) n.delete(l.id); else n.add(l.id); setPicked(n) }}>
                <span className={`check ${picked.has(l.id) ? 'on' : ''}`}>{picked.has(l.id) && <Icon name="check" size={13} strokeWidth={2.6} />}</span>
                {l.id === 'LL' ? <span className="sb-pl-art liked" style={{ width: 38, height: 38 }}><Icon name="heartFill" size={16} /></span> : <Artwork src={l.art} className="imp-art" seed={l.title} />}
                <span className="grow col" style={{ gap: 0 }}><span className="ellipsis">{l.title}</span>{l.id !== 'LL' && <span className="t-caption">{l.count} videos</span>}</span>
              </button>
            ))}
          </div>
          {progress && <div className="t-caption"><Spinner size={12} /> Importing {progress.label} ({progress.done + 1}/{progress.total})</div>}
          {error && <Notice tone="error">{error}</Notice>}
          <button className="btn btn-primary btn-lg" disabled={busy || picked.size === 0} onClick={() => void run()}>{busy ? <Spinner /> : null} Import {picked.size} {picked.size === 1 ? 'playlist' : 'playlists'}</button>
        </div>
      )}
    </Sheet>
  )
}
