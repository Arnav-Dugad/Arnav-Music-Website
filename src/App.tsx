import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { AnimatePresence, motion, MotionConfig } from 'motion/react'
import { Sidebar, TabBar } from './components/Shell'
import { PlayerBar, MiniPlayer, PreviewPill } from './components/PlayerBar'
import { NowPlaying } from './components/NowPlaying'
import { AddToPlaylist, AuthSheet, CommandPalette, ShortcutsSheet, Toasts, TrackMenu, useShortcuts } from './components/Overlays'
import { VideoHost } from './player/VideoHost'
import { PhoneSheet } from './components/PhoneLink'
import { CinematicLyrics } from './components/Cinematic'
import { DockPanel } from './components/Dock'
import { useCurrentPalette, useIsDesktop, useThemeEffects } from './hooks'
import { useMotionLevel, useSettings } from './state/settings'
import { usePlayer } from './state/player'
import { Spinner } from './components/ui'
import { PageBoundary, QuietBoundary } from './components/ErrorBoundary'
import { isMorphing } from './lib/reveal'
import { TogetherLayer } from './components/TogetherLayer'
import { SendSheet } from './components/Social'
import { MobileAccountButton, TopTabs, MoreSheet } from './components/MobileMenu'
import { YtLinkReview } from './components/YouTubeMusic'
import Home from './pages/Home'

const Explore = lazy(() => import('./pages/Explore'))
const ReplayPage = lazy(() => import('./pages/Replay'))
const PublicPlaylistPage = lazy(() => import('./pages/PublicPlaylist'))
const Library = lazy(() => import('./pages/Library'))
const PlaylistPage = lazy(() => import('./pages/Playlist'))
const ArtistPage = lazy(() => import('./pages/Artist'))
const AlbumPage = lazy(() => import('./pages/Album'))
const CreditsPage = lazy(() => import('./pages/Credits'))
const WrappedPage = lazy(() => import('./pages/Wrapped'))
const WallPage = lazy(() => import('./pages/Wall'))
const TogetherPage = lazy(() => import('./pages/Together'))
const FriendsPage = lazy(() => import('./pages/Friends'))
const ProfilePage = lazy(() => import('./pages/Profile'))
const AiPage = lazy(() => import('./pages/Ai'))
const MomentsPage = lazy(() => import('./pages/Moments'))
const MomentPage = lazy(() => import('./pages/Moment'))
const Insights = lazy(() => import('./pages/Insights'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const Onboarding = lazy(() => import('./pages/Onboarding'))
const TrackLink = lazy(() => import('./pages/TrackLink'))
const NotFound = lazy(() => import('./pages/NotFound'))
const Share = lazy(() => import('./pages/Share'))

function Page({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      // A cover morph (View Transition) already animates the change; don't fade the page under it.
      initial={isMorphing() ? false : { opacity: 0, y: 12 }}
      // Opacity and movement only: a full-page blur is costly to paint and delays the next page.
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 260, damping: 30 }}
    >
      {children}
    </motion.div>
  )
}

function Fallback() {
  return <div className="center" style={{ height: '60vh' }}><Spinner size={26} /></div>
}

export default function App() {
  const loc = useLocation()
  const nav = useNavigate()
  const desktop = useIsDesktop()
  const palette = useCurrentPalette()
  useThemeEffects(palette)
  useShortcuts()
  const motionLevel = useMotionLevel()
  const onboardingDone = useSettings((s) => s.onboardingDone)
  const hasTrack = usePlayer((s) => s.queue.length > 0)
  const expanded = usePlayer((s) => s.expanded)
  const trackKey = usePlayer((s) => s.queue[s.index]?.track.id ?? '')
  const scroller = useRef<HTMLDivElement>(null)
  const docked = useSettings((s) => s.dockedPlayer) && desktop && hasTrack

  useEffect(() => {
    // Shared links (a song, a listening room) open straight away, even on a first visit.
    if (!onboardingDone && !/^\/(welcome|track\/|together|add\/|u\/|friends|p\/|share)/.test(loc.pathname)) nav('/welcome', { replace: true })
  }, [onboardingDone, loc.pathname, nav])
  // Back and Forward return to where you were on that page; anything new starts at the top.
  const navType = useNavigationType()
  const scrollSaved = useRef(new Map<string, number>())
  const lastKey = useRef(loc.key)
  const [announce, setAnnounce] = useState('')
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => { scrollSaved.current.set(lastKey.current, el.scrollTop) }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useEffect(() => {
    const el = scroller.current
    lastKey.current = loc.key
    if (!el) return
    const target = navType === 'POP' ? scrollSaved.current.get(loc.key) ?? 0 : 0
    // Pages fill in as their data arrives: keep trying for a moment until the spot exists.
    let tries = 0
    let raf = 0
    const go = () => {
      el.scrollTop = target
      if (Math.abs(el.scrollTop - target) > 2 && ++tries < 45) raf = requestAnimationFrame(go)
    }
    go()
    // Screen readers hear the new page's name; keyboard focus moves to its heading.
    const t = setTimeout(() => {
      const h1 = el.querySelector('h1')
      setAnnounce(h1?.textContent?.trim() || '')
      if (h1 && navType !== 'POP' && document.activeElement === document.body) { h1.tabIndex = -1; h1.focus({ preventScroll: true }) }
    }, 450)
    return () => { cancelAnimationFrame(raf); clearTimeout(t) }
  }, [loc.key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (expanded) usePlayer.getState().setExpanded(false) }, [loc.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  const onboarding = loc.pathname.startsWith('/welcome')
  return (
    <MotionConfig reducedMotion={motionLevel === 'full' ? 'user' : 'always'}>
      <div className={`app ${desktop ? 'desktop' : 'mobile'} ${hasTrack ? 'has-track' : ''} ${onboarding ? 'onboarding' : ''} ${docked && !onboarding ? 'docked' : ''} ${expanded && !desktop ? 'np-open' : ''} ${/^\/(wrapped|wall)(\/|$)/.test(loc.pathname) ? 'immersive' : ''}`}>
        <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); scroller.current?.focus() }}>Skip to content</a>
        <div className="sr-only" aria-live="polite" aria-atomic="true">{announce}</div>
        <div className="ambient" aria-hidden><div className="ambient-glow" /></div>
        {desktop && !onboarding && <Sidebar />}
        <main className="main-scroll" ref={scroller} id="main" tabIndex={-1}>
          <PageBoundary resetKey={loc.pathname}>
          <Suspense fallback={<Fallback />}>
            <AnimatePresence mode="wait" initial={false}>
              <Routes location={loc} key={loc.pathname}>
                <Route path="/" element={<Page><Home /></Page>} />
                <Route path="/explore" element={<Page><Explore /></Page>} />
                <Route path="/search" element={<Page><Explore /></Page>} />
                <Route path="/library" element={<Page><Library /></Page>} />
                <Route path="/library/:tab" element={<Page><Library /></Page>} />
                <Route path="/playlist/:id" element={<Page><PlaylistPage /></Page>} />
                <Route path="/p/:id" element={<Page><PublicPlaylistPage /></Page>} />
                <Route path="/artist/:name" element={<Page><ArtistPage /></Page>} />
                <Route path="/album/:name" element={<Page><AlbumPage /></Page>} />
                <Route path="/credits/:id" element={<Page><CreditsPage /></Page>} />
                <Route path="/replay" element={<Page><ReplayPage /></Page>} />
                <Route path="/replay/:period" element={<Page><ReplayPage /></Page>} />
                <Route path="/wrapped" element={<WrappedPage />} />
                <Route path="/wrapped/:month" element={<WrappedPage />} />
                <Route path="/wall" element={<WallPage />} />
                <Route path="/together" element={<Page><TogetherPage /></Page>} />
                <Route path="/together/:code" element={<Page><TogetherPage /></Page>} />
                <Route path="/friends" element={<Page><FriendsPage /></Page>} />
                <Route path="/add/:code" element={<Page><FriendsPage /></Page>} />
                <Route path="/u/:handle" element={<Page><ProfilePage /></Page>} />
                <Route path="/ai" element={<Page><AiPage /></Page>} />
                <Route path="/moments" element={<Page><MomentsPage /></Page>} />
                <Route path="/moment/:id" element={<MomentPage />} />
                <Route path="/insights" element={<Page><Insights /></Page>} />
                <Route path="/settings" element={<Page><SettingsPage /></Page>} />
                <Route path="/settings/:section" element={<Page><SettingsPage /></Page>} />
                <Route path="/welcome" element={<Onboarding />} />
                <Route path="/track/:videoId" element={<TrackLink />} />
                <Route path="/share" element={<Share />} />
                <Route path="*" element={<Page><NotFound /></Page>} />
              </Routes>
            </AnimatePresence>
          </Suspense>
          </PageBoundary>
        </main>
        {!onboarding && (desktop ? <PlayerBar /> : <><TopTabs /><MiniPlayer /><TabBar /><MobileAccountButton /><MoreSheet /></>)}
        <QuietBoundary name="dock" resetKey={trackKey}><DockPanel /></QuietBoundary>
        <QuietBoundary name="now playing" resetKey={trackKey}><NowPlaying /></QuietBoundary>
        <QuietBoundary name="cinematic" resetKey={trackKey}><CinematicLyrics /></QuietBoundary>
        <VideoHost />
        <QuietBoundary name="track menu"><TrackMenu /></QuietBoundary>
        <QuietBoundary name="add to playlist"><AddToPlaylist /></QuietBoundary>
        <QuietBoundary name="command palette"><CommandPalette /></QuietBoundary>
        <QuietBoundary name="shortcuts"><ShortcutsSheet /></QuietBoundary>
        <QuietBoundary name="sign in"><AuthSheet /></QuietBoundary>
        <QuietBoundary name="phone"><PhoneSheet /></QuietBoundary>
        <QuietBoundary name="youtube music"><YtLinkReview /></QuietBoundary>
        <Toasts />
        <QuietBoundary name="preview"><PreviewPill /></QuietBoundary>
        <QuietBoundary name="together"><TogetherLayer /></QuietBoundary>
        <QuietBoundary name="send"><SendSheet /></QuietBoundary>
      </div>
    </MotionConfig>
  )
}
