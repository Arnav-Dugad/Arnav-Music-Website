/**
 * Samples: a swipeable feed of songs picked for you. Each card plays a 30-second clip as it comes
 * into view; like it, queue it, keep it in a playlist, or play the whole song. Whatever you were
 * listening to comes back when you leave.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Icon } from '../components/Icon'
import { Artwork, Empty } from '../components/ui'
import { artworkFor } from '../lib/classify'
import { endPreview, isPreviewing, startPreview } from '../player/controller'
import { forYouNow, freshFinds, radioFor, type Rec } from '../services/recs'
import { likedIds, useLibrary } from '../state/library'
import { player, usePlayer } from '../state/player'
import { toast, ui } from '../state/ui'
import { useRegistryVersion } from '../hooks'
import { artistHref, splitArtists } from '../components/TrackRow'

const CLIP_MS = 30_000

export default function Samples() {
  const nav = useNavigate()
  const v = useRegistryVersion()
  const likes = useLibrary((s) => s.likes)
  // A fresh deck each visit: new songs first, then close favourites-to-be (liked songs left out).
  const initial = useMemo(() => {
    const liked = likedIds(likes)
    const seen = new Set<string>()
    const out: Rec[] = []
    for (const r of [...freshFinds(30), ...forYouNow(30)]) if (!seen.has(r.track.id) && !liked.has(r.track.id)) { seen.add(r.track.id); out.push(r) }
    return out.slice(0, 40)
  }, [v]) // eslint-disable-line react-hooks/exhaustive-deps
  const [deck, setDeck] = useState<Rec[]>(initial)
  useEffect(() => { setDeck((d) => (d.length ? d : initial)) }, [initial])
  /** The rest of the feed becomes songs like [i]'s. */
  const moreLike = async (i: number) => {
    const seed = deck[i]?.track
    if (!seed) return
    const more = await radioFor(seed, { exclude: new Set(deck.slice(0, i + 1).map((r) => r.track.id)), limit: 20 }).catch(() => [] as Rec[])
    if (!more.length) { toast('No more songs like this right now'); return }
    setDeck((d) => [...d.slice(0, i + 1), ...more.map((r) => ({ ...r, caption: `Like ${seed.title}` }))])
    toast(`Next: songs like “${seed.title}”`)
    setTimeout(() => go(1), 250)
  }
  const feed = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const [hinted, setHinted] = useState(false)

  // The card filling the screen is the one playing.
  useEffect(() => {
    const el = feed.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i))
    }, { root: el, threshold: 0.6 })
    el.querySelectorAll('.sample').forEach((c) => io.observe(c))
    return () => io.disconnect()
  }, [deck])
  useEffect(() => {
    const t = deck[active]?.track
    if (!t) return
    const h = setTimeout(() => startPreview(t, CLIP_MS), 350)
    if (active > 0) setHinted(true)
    return () => clearTimeout(h)
  }, [active, deck])
  // Leaving Samples: back to what you were listening to.
  useEffect(() => () => { if (isPreviewing()) endPreview() }, [])
  const go = (d: number) => feed.current?.scrollBy({ top: d * feed.current.clientHeight, behavior: 'smooth' })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return
      if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); go(1) }
      if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); go(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!deck.length) {
    return (
      <div className="page">
        <h1 className="sr-only">Samples</h1>
        <Empty icon="bolt" title="Samples need a little listening first" body="Play or like a few songs and Samples fills with new music picked for you."
          action={<button className="btn btn-primary" onClick={() => nav('/explore')}><Icon name="compass" size={15} /> Explore music</button>} />
      </div>
    )
  }
  return (
    <div className="samples-page">
      <h1 className="sr-only">Samples</h1>
      <div className="samples-feed" ref={feed} role="feed" aria-label="Samples: new songs picked for you">
        {deck.map((r, i) => <Sample key={r.track.id} r={r} i={i} active={i === active} total={deck.length} onNext={() => go(1)} onMore={() => void moreLike(i)} />)}
      </div>
      {!hinted && <motion.div className="samples-hint" initial={{ opacity: 0, y: -10, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} transition={{ delay: 1.2 }}><Icon name="chevronUp" size={16} /> Swipe up for the next song</motion.div>}
    </div>
  )
}

function Sample({ r, i, active, total, onNext, onMore }: { r: Rec; i: number; active: boolean; total: number; onNext: () => void; onMore: () => void }) {
  const nav = useNavigate()
  const t = r.track
  const liked = useLibrary((s) => !!s.likes[t.id] && !s.likes[t.id].deleted)
  const previewing = usePlayer((s) => s.previewing?.id === t.id)
  const art = artworkFor(t)
  const artists = splitArtists(t.artist)
  return (
    <article className={`sample ${active ? 'active' : ''}`} data-i={i} aria-setsize={total} aria-posinset={i + 1} aria-label={`${t.title} by ${t.artist}`}>
      <div className="sample-bg" style={{ backgroundImage: `url("${art}")` }} aria-hidden />
      <div className="sample-body">
        <motion.div className="sample-art" animate={active ? { scale: 1, opacity: 1 } : { scale: 0.9, opacity: 0.6 }} transition={{ type: 'spring', stiffness: 220, damping: 26 }}>
          <Artwork src={art} letterbox={false} />
          {active && previewing && <div className="sample-progress" aria-hidden><i key={t.id} /></div>}
        </motion.div>
        <div className="sample-copy">
          <div className="t-eyebrow sample-why"><Icon name="sparkles" size={12} /> {r.caption || 'Picked for you'}</div>
          <h2 className="sample-title">{t.title}</h2>
          <div className="sample-artist">
            {artists.map((a, k) => <span key={a}>{k > 0 && ', '}<button className="link" onClick={() => nav(artistHref(t, a, artists.length === 1))}>{a}</button></span>)}
          </div>
        </div>
        <div className="sample-actions">
          <button className={`sample-act ${liked ? 'on' : ''}`} aria-pressed={liked} aria-label={liked ? 'Unlike' : 'Like'} onClick={() => { const on = useLibrary.getState().toggleLike(t); toast(on ? 'Added to Liked Songs' : 'Removed from Liked Songs') }}>
            <Icon name={liked ? 'heartFill' : 'heart'} size={24} /><span>{liked ? 'Liked' : 'Like'}</span>
          </button>
          <button className="sample-act" aria-label="Add to queue" onClick={() => { player().addToQueue([t]); toast('Added to your queue') }}><Icon name="queue" size={24} /><span>Queue</span></button>
          <button className="sample-act" aria-label="Add to a playlist" onClick={() => ui().set({ addTo: [t] })}><Icon name="plus" size={24} /><span>Save</span></button>
          <button className="sample-act" aria-label={`More songs like ${t.title}`} onClick={onMore}><Icon name="radio" size={24} /><span>More</span></button>
          <button className="sample-act play" aria-label={`Play ${t.title}`} onClick={() => { endPreview(); player().play([t], 0, { context: 'Samples' }) }}><Icon name="play" size={24} /><span>Play</span></button>
        </div>
      </div>
      {i < total - 1 && <button className="sample-next" onClick={onNext} aria-label="Next sample"><Icon name="chevronDown" size={20} /></button>}
    </article>
  )
}
