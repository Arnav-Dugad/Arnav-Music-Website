import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from './Icon'
import { Spinner } from './ui'
import { aiAvailability, AI_REASON_COPY } from '../lib/ai'
import { filmMusic, type FilmMusic } from '../lib/aiFeatures'
import { toast } from '../state/ui'

/** "Ask Arnav AI about this film's music": the sound of it, the composer's other work, soundtracks like it. */
export function FilmMusicAi({ film }: { film: { title: string; year: number | null; composers: string[]; director: string | null; songs: string[] } }) {
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState<FilmMusic | null>(null)
  const ask = async () => {
    const blocked = aiAvailability()
    if (blocked) { toast(AI_REASON_COPY[blocked].replace(' — answered on device.', '.')); return }
    setBusy(true)
    try {
      const r = await filmMusic(film)
      if (!r) toast('Arnav AI couldn’t answer about this film right now')
      setData(r)
    } finally { setBusy(false) }
  }
  const open = (title: string, artist?: string | null) => nav(`/album/${encodeURIComponent(title)}${artist ? `?a=${encodeURIComponent(artist)}` : ''}`)
  return (
    <div className="filmai">
      {!data && (
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void ask()}>
          {busy ? <Spinner size={14} /> : <Icon name="sparkles" size={15} />} Ask Arnav AI about this film’s music
        </button>
      )}
      <AnimatePresence>
        {data && (
          <motion.div className="filmai-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="badge ai">The music of {film.title} · Arnav AI</span><button className="icon-btn sm" aria-label="Close" onClick={() => setData(null)}><Icon name="close" size={14} /></button></div>
            <p className="filmai-intro">{data.intro}</p>
            {data.composers.filter((c) => c.works.length).map((c) => (
              <div key={c.name} className="filmai-block">
                <div className="filmai-h">More from <button className="link" onClick={() => nav(`/artist/${encodeURIComponent(c.name)}`)}>{c.name}</button></div>
                <div className="filmai-chips">{c.works.map((w) => <button key={w.title} className="chip" onClick={() => open(w.title, c.name)}>{w.title}{w.year ? <span className="t-caption"> · {w.year}</span> : null}</button>)}</div>
              </div>
            ))}
            {data.similar.length > 0 && (
              <div className="filmai-block">
                <div className="filmai-h">Soundtracks like it</div>
                <div className="filmai-list">
                  {data.similar.map((x) => (
                    <button key={x.title} className="filmai-row" onClick={() => open(x.title, x.composer)}>
                      <span className="grow"><b>{x.title}</b>{x.year ? <span className="t-caption"> · {x.year}</span> : null}{x.composer ? <span className="t-caption"> · {x.composer}</span> : null}<span className="filmai-why">{x.why}</span></span>
                      <Icon name="chevronRight" size={15} />
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="t-caption">Written by Arnav AI from what it knows — check details before you rely on them.</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
