import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Artwork, Sheet } from './ui'
import { Icon } from './Icon'
import { findDuplicates, keepVersion, undoDedupe, type DuplicateGroup } from '../services/importer'
import { artworkFor } from '../lib/classify'
import { duration } from '../lib/format'
import { player } from '../state/player'
import { toast } from '../state/ui'

const trustLabel = (t?: number | null) => (t === 3 ? 'Official' : t === 2 ? 'Artist channel' : t === 1 ? 'Established channel' : t === 0 ? 'Unverified upload' : 'Saved earlier')

/** The same song saved as different uploads — keep one version everywhere, with undo. */
export function DuplicatesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [groups, setGroups] = useState<DuplicateGroup[]>([])
  useEffect(() => { if (open) setGroups(findDuplicates()) }, [open])
  return (
    <Sheet open={open} onClose={onClose} title="Duplicate songs" width={600}>
      {groups.length === 0 ? (
        <div className="empty" style={{ padding: '30px 10px' }}>
          <div className="empty-icon"><Icon name="check" size={26} /></div>
          <div className="t-title">No duplicates</div>
          <div className="t-sub">Every song in your likes and playlists is saved once.</div>
        </div>
      ) : (
        <div className="col" style={{ gap: 14 }}>
          <div className="t-sub">{groups.length} {groups.length === 1 ? 'song is' : 'songs are'} saved as more than one upload. Keep one version and it replaces the others in every playlist and in Liked Songs.</div>
          <AnimatePresence initial={false}>
            {groups.map((g) => (
              <motion.div key={g.key} className="dup-group" layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, marginBottom: -14 }}>
                {g.versions.map((v, i) => (
                  <div key={v.track.id} className="dup-row">
                    <button className="dup-art" onClick={() => player().play([v.track], 0, { context: 'Duplicate check' })} aria-label={`Play ${v.track.title}`}>
                      <Artwork src={artworkFor(v.track, 'sm')} letterbox={false} />
                      <span className="qp-ov"><Icon name="play" size={14} /></span>
                    </button>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>{v.track.title}</span>
                      <span className="t-caption ellipsis" style={{ display: 'block' }}>{v.track.channelTitle ?? v.track.artist} · {trustLabel(v.track.trust)} · {duration(v.track.durationMs)} · in {v.uses} {v.uses === 1 ? 'playlist' : 'playlists'}{v.liked ? ' · liked' : ''}</span>
                    </span>
                    <button className={`btn btn-sm ${i === 0 ? 'btn-primary' : 'btn-secondary'}`} onClick={() => {
                      const undo = keepVersion(g, v.track)
                      setGroups((gs) => gs.filter((x) => x.key !== g.key))
                      toast('Kept one version everywhere', { label: 'Undo', run: () => { undoDedupe(undo); setGroups(findDuplicates()) } })
                    }}>Keep this</button>
                  </div>
                ))}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </Sheet>
  )
}
