import { lazy, Suspense, useEffect, useRef } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
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
import { useSettings } from './state/settings'
import { usePlayer } from './state/player'
import { Spinner } from './components/ui'
import { PageBoundary } from './components/ErrorBoundary'
import { isMorphing } from './lib/reveal'
import { TogetherLayer } from './components/TogetherLayer'
import Home from './pages/Home'

const Explore = lazy(() => import('./pages/Explore'))
const Library = lazy(() => import('./pages/Library'))
const PlaylistPage = lazy(() => import('./pages/Playlist'))
const ArtistPage = lazy(() => import('./pages/Artist'))
const AlbumPage = lazy(() => import('./pages/Album'))
const CreditsPage = lazy(() => import('./pages/Credits'))
const WrappedPage = lazy(() => import('./pages/Wrapped'))
const WallPage = lazy(() => import('./pages/Wall'))
const TogetherPage = lazy(() => import('./pages/Together'))
const AiPage = lazy(() => import('./pages/Ai'))
const MomentsPage = lazy(() => import('./pages/Moments'))
const MomentPage = lazy(() => import('./pages/Moment'))
const Insights = lazy(() => import('./pages/Insights'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const Onboarding = lazy(() => import('./pages/Onboarding'))
const TrackLink = lazy(() => import('./pages/TrackLink'))
const NotFound = lazy(() => import('./pages/NotFound'))

function Page({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      // A cover morph (View Transition) already animates the change; don't fade the page under it.
      initial={isMorphing() ? false : { opacity: 0, y: 14, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -8, filter: 'blur(4px)', transition: { duration: 0.16 } }}
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
  const motionLevel = useSettings((s) => s.motion)
  const onboardingDone = useSettings((s) => s.onboardingDone)
  const hasTrack = usePlayer((s) => s.queue.length > 0)
  const expanded = usePlayer((s) => s.expanded)
  const scroller = useRef<HTMLDivElement>(null)
  const docked = useSettings((s) => s.dockedPlayer) && desktop && hasTrack

  useEffect(() => {
    // Shared links (a song, a listening room) open straight away, even on a first visit.
    if (!onboardingDone && !/^\/(welcome|track\/|together\/)/.test(loc.pathname)) nav('/welcome', { replace: true })
  }, [onboardingDone, loc.pathname, nav])
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }) }, [loc.pathname])
  useEffect(() => { if (expanded) usePlayer.getState().setExpanded(false) }, [loc.pathname]) // eslint-disable-line react-hooks/exhaustive-deps

  const onboarding = loc.pathname.startsWith('/welcome')
  return (
    <MotionConfig reducedMotion={motionLevel === 'full' ? 'user' : 'always'}>
      <div className={`app ${desktop ? 'desktop' : 'mobile'} ${hasTrack ? 'has-track' : ''} ${onboarding ? 'onboarding' : ''} ${docked && !onboarding ? 'docked' : ''} ${/^\/(wrapped|wall)(\/|$)/.test(loc.pathname) ? 'immersive' : ''}`}>
        <div className="ambient" aria-hidden><div className="ambient-glow" /></div>
        {desktop && !onboarding && <Sidebar />}
        <main className="main-scroll" ref={scroller} id="main">
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
                <Route path="/artist/:name" element={<Page><ArtistPage /></Page>} />
                <Route path="/album/:name" element={<Page><AlbumPage /></Page>} />
                <Route path="/credits/:id" element={<Page><CreditsPage /></Page>} />
                <Route path="/wrapped" element={<WrappedPage />} />
                <Route path="/wrapped/:month" element={<WrappedPage />} />
                <Route path="/wall" element={<WallPage />} />
                <Route path="/together" element={<Page><TogetherPage /></Page>} />
                <Route path="/together/:code" element={<Page><TogetherPage /></Page>} />
                <Route path="/ai" element={<Page><AiPage /></Page>} />
                <Route path="/moments" element={<Page><MomentsPage /></Page>} />
                <Route path="/moment/:id" element={<MomentPage />} />
                <Route path="/insights" element={<Page><Insights /></Page>} />
                <Route path="/settings" element={<Page><SettingsPage /></Page>} />
                <Route path="/settings/:section" element={<Page><SettingsPage /></Page>} />
                <Route path="/welcome" element={<Onboarding />} />
                <Route path="/track/:videoId" element={<TrackLink />} />
                <Route path="*" element={<Page><NotFound /></Page>} />
              </Routes>
            </AnimatePresence>
          </Suspense>
          </PageBoundary>
        </main>
        {!onboarding && (desktop ? <PlayerBar /> : <><MiniPlayer /><TabBar /></>)}
        <DockPanel />
        <NowPlaying />
        <CinematicLyrics />
        <VideoHost />
        <TrackMenu />
        <AddToPlaylist />
        <CommandPalette />
        <ShortcutsSheet />
        <AuthSheet />
        <PhoneSheet />
        <Toasts />
        <PreviewPill />
        <TogetherLayer />
      </div>
    </MotionConfig>
  )
}
