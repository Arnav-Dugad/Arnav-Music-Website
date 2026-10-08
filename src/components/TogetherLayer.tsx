import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from 'react-router-dom'
import { react, REACTIONS, useTogether } from '../services/together'

/** Reactions floating up every screen in the room, and a live pill back to the room. */
export function TogetherLayer() {
  const code = useTogether((s) => s.code)
  const status = useTogether((s) => s.status)
  const members = useTogether((s) => s.members.length)
  const following = useTogether((s) => s.following)
  const isHost = useTogether((s) => !!s.you && s.you === s.hostId)
  const reactions = useTogether((s) => s.reactions)
  const nav = useNavigate()
  if (!code) return null
  return (
    <>
      <motion.button className={`together-pill glass-thick ${status}`} initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} onClick={() => nav(`/together/${code}`)} aria-label="Open the listening room">
        <i className="dot" /> {isHost ? 'Hosting' : following ? 'Together' : 'Out of sync'} · {members}
      </motion.button>
      <div className="react-layer" aria-live="polite">
        <AnimatePresence>
          {reactions.slice(-14).map((r, i) => {
            const x = ((r.key.charCodeAt(0) + i * 37) % 60) - 30
            return (
              <motion.div key={r.key} className={`react-bubble ${r.mine ? 'mine' : ''}`}
                initial={{ opacity: 0, y: 30, x, scale: 0.6 }}
                animate={{ opacity: [0, 1, 1, 0], y: -260, x: x + (i % 2 ? 24 : -24), scale: [0.6, 1.25, 1, 0.9] }}
                exit={{ opacity: 0 }}
                transition={{ duration: 3.2, ease: [0.2, 0.8, 0.2, 1] }}>
                <span className="react-emoji">{r.emoji}</span>
                <span className="react-name">{r.mine ? 'You' : r.name}</span>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </>
  )
}

/** Quick reactions in Now Playing while you're in a room. */
export function RoomReactBar() {
  const code = useTogether((s) => s.code)
  if (!code) return null
  return (
    <div className="np-reacts" role="group" aria-label="React to the room">
      {REACTIONS.slice(0, 6).map((e) => <motion.button key={e} whileTap={{ scale: 0.75 }} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</motion.button>)}
    </div>
  )
}
