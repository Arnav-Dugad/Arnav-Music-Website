import { useRef, useState } from 'react'
import { motion } from 'motion/react'
import { Notice, Segmented, Sheet, Spinner } from './ui'
import { Icon } from './Icon'
import { readImportFile, type ImportList } from '../lib/importFiles'
import { redoImport, resumePending, runImport, undoImport, useImports } from '../services/importer'
import { relative } from '../lib/format'
import { toast } from '../state/ui'
import { useYoutubeReady } from '../services/status'

/** Spotify (data export .zip/.json) and CSV playlist import, with resume and undo/redo history. */
export function ImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'import' | 'history'>('import')
  const [lists, setLists] = useState<ImportList[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [source, setSource] = useState<'spotify' | 'csv'>('spotify')
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const { pending, history, running } = useImports()
  const yt = useYoutubeReady()

  const readFiles = async (files: FileList | File[]) => {
    setError(null); setReading(true)
    try {
      const all: ImportList[] = []
      let csv = false
      for (const f of [...files]) {
        if (f.name.toLowerCase().endsWith('.csv')) csv = true
        all.push(...(await readImportFile(f)))
      }
      if (!all.length) throw new Error('No songs found in that file.')
      setSource(csv ? 'csv' : 'spotify')
      setLists(all)
      setPicked(new Set(all.map((_, i) => i)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file couldn’t be read.')
    } finally {
      setReading(false)
    }
  }

  const start = async () => {
    if (!lists) return
    const chosen = lists.filter((_, i) => picked.has(i))
    const rec = await runImport(chosen, source)
    const left = useImports.getState().pending.reduce((a, p) => a + p.items.length, 0)
    toast(`Matched ${rec.matched} of ${rec.total} songs${left ? ` · ${left} more tomorrow when quota resets` : ''}`)
    setLists(null)
    setTab('history')
  }

  const totalSongs = lists?.filter((_, i) => picked.has(i)).reduce((a, l) => a + l.items.length, 0) ?? 0

  return (
    <Sheet open={open} onClose={() => { if (!running) onClose() }} title="Import Spotify or CSV" width={560}>
      <Segmented id="imp-tab" size="sm" value={tab} onChange={setTab} options={[{ value: 'import', label: 'Import' }, { value: 'history', label: `History${history.length ? ` · ${history.length}` : ''}` }]} />
      <div style={{ marginTop: 16 }}>
        {tab === 'import' ? (
          running ? (
            <div className="col" style={{ gap: 12, padding: '20px 0' }}>
              <div className="t-headline">Matching “{running.label}”…</div>
              <div className="quota-bar"><motion.i animate={{ scaleX: running.total ? running.done / running.total : 0 }} transition={{ duration: 0.3 }} /></div>
              <div className="t-caption">{running.done} of {running.total} songs · your library first, then official YouTube uploads</div>
            </div>
          ) : lists ? (
            <div className="col" style={{ gap: 10 }}>
              <div className="col" style={{ gap: 2, maxHeight: '42vh', overflowY: 'auto' }}>
                {lists.map((l, i) => (
                  <button key={i} className="menu-item" style={{ height: 52 }} onClick={() => { const n = new Set(picked); if (n.has(i)) n.delete(i); else n.add(i); setPicked(n) }}>
                    <span className={`check ${picked.has(i) ? 'on' : ''}`}>{picked.has(i) && <Icon name="check" size={13} strokeWidth={2.6} />}</span>
                    <span className="sb-pl-art" style={{ background: l.kind === 'liked' ? 'linear-gradient(135deg,#7b5cff,#3b2ecc)' : l.kind === 'top' ? 'linear-gradient(135deg,#1db954,#0a6b2f)' : 'var(--surface-2)', color: '#fff' }}>
                      <Icon name={l.kind === 'liked' ? 'heartFill' : l.kind === 'top' ? 'trophy' : 'note'} size={14} />
                    </span>
                    <span className="grow col" style={{ gap: 0 }}><span className="ellipsis">{l.name}</span><span className="t-caption">{l.items.length} songs{l.kind === 'liked' ? ' · added to Liked Songs' : ''}</span></span>
                  </button>
                ))}
              </div>
              {!yt.ready && <Notice tone="warn">YouTube isn’t connected, so only songs already in your library can be matched.</Notice>}
              <div className="t-caption">Matching uses your library first, then official uploads only. Each new search uses YouTube quota, so very large imports continue automatically over the next days.</div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" onClick={() => setLists(null)}>Back</button>
                <button className="btn btn-primary" disabled={!picked.size} onClick={() => void start()}><Icon name="download" size={15} /> Import {totalSongs} songs</button>
              </div>
            </div>
          ) : (
            <div className="col" style={{ gap: 14 }}>
              <div
                className={`dropzone ${drag ? 'on' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void readFiles(e.dataTransfer.files) }}
                onClick={() => input.current?.click()}
                role="button"
                tabIndex={0}
              >
                {reading ? <Spinner size={22} /> : <Icon name="upload" size={26} />}
                <div className="t-headline">Drop your Spotify export or a CSV</div>
                <div className="t-caption">Spotify: Account → Privacy → Download your data (the .zip, or YourLibrary.json / Playlist1.json). CSV: any file with title and artist columns, like Exportify.</div>
                <input ref={input} type="file" accept=".zip,.json,.csv,text/csv,application/json,application/zip" multiple hidden onChange={(e) => { if (e.target.files?.length) void readFiles(e.target.files); e.target.value = '' }} />
              </div>
              {error && <Notice tone="error">{error}</Notice>}
              {pending.length > 0 && (
                <Notice tone="info" icon="clock" action={<button className="btn btn-secondary btn-sm" disabled={!yt.ready} onClick={() => void resumePending().then((n) => toast(`Matched ${n} more songs`))}>Continue</button>}>
                  {pending.reduce((a, p) => a + p.items.length, 0)} songs from earlier imports are waiting for quota.
                </Notice>
              )}
            </div>
          )
        ) : history.length === 0 ? (
          <div className="t-sub" style={{ padding: '20px 0' }}>Imports you run show up here — undo or redo any of them.</div>
        ) : (
          <div className="col" style={{ gap: 2 }}>
            {history.map((h) => (
              <div key={h.id} className="device-row">
                <span className="device-icon"><Icon name={h.source === 'csv' ? 'list' : 'note'} size={15} /></span>
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="ellipsis" style={{ display: 'block', fontWeight: 600, opacity: h.undone ? 0.5 : 1 }}>{h.label}</span>
                  <span className="t-caption">{h.source === 'csv' ? 'CSV' : 'Spotify'} · {h.matched}/{h.total} matched · {relative(h.createdAt)}{h.undone ? ' · undone' : ''}</span>
                </span>
                {h.undone
                  ? <button className="btn btn-ghost btn-sm" onClick={() => void redoImport(h.id).then(() => toast('Import restored'))}>Redo</button>
                  : <button className="btn btn-ghost btn-sm" onClick={() => void undoImport(h.id).then(() => toast('Import undone', { label: 'Redo', run: () => void redoImport(h.id) }))}>Undo</button>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}
