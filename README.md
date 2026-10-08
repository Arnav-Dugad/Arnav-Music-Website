<div align="center">

<img src="public/icons/icon.svg" width="96" alt="Arnav Music" />

# Arnav Music — Web
**Music, alive.** The web edition of [Arnav Music](https://github.com/Arnav-Dugad/Arnav-Music-Background), on the same backend as the Android app.

**Live:** https://arnav-music.arnavrival12.workers.dev

</div>

---

## What it is
A premium, Apple-style music web app: YouTube discovery through the official APIs, Apple-Music-style synced lyrics, **Arnav AI** sessions (Gemini), immersive **Moments**, and **Taste DNA**. It uses the same Firebase project, data model and security rules as the Android app, so likes, playlists, listening history and your queue follow you between phone and browser.

## Highlights
- **Now Playing that morphs** out of the player bar (shared-element artwork). A living gradient follows the cover's colours. The cover breathes while playing and settles when paused, and songs swap with a depth transition. Swipe the cover to skip, double-tap its sides to seek ±5 s, and it fades to ambient after a few idle seconds with an edge glow.
- **Song / Video switch** like YouTube Music. One official YouTube player is never reloaded; it glides into the Video slot.
- **Lyrics, Apple style**: LRCLIB time-synced lines glide into place with a cascade, with word-by-word fill (enhanced LRC or syllable-estimated). Backing vocals sit small under the lead, dots breathe through instrumental breaks, and you can tap a line to seek. Free-scroll resumes on its own. **AI translation + romanisation**, AI-written lyrics when none exist (labelled), paste your own, and a "download lyrics for a playlist" option.
- **Arnav AI**: "45 minutes of energetic coding music, mostly familiar, a few surprises" goes to Gemini (Firebase AI Logic) for structured constraints. Real songs are found cache-first, then a deterministic energy-curve ordering is applied, with an interactive energy chart, a reason for every pick, and one-tap refinements. The on-device engine (a port of the app's `LocalIntentEngine`) always answers when the cloud can't.
- **Home** is composed like the app: Continue listening, For you right now (quick picks with honest captions), Moments, smart playlists (Heavy Rotation, Forgotten Favorites, Night Owl…), Daily mixes, Time Machine, Fresh finds, Rediscover, Trending, plus a **handoff card** that resumes your phone's queue.
- **Moments**: ten procedural canvas environments (drift, pulse, rain, shimmer, still, surge), each with its own typography.
- **Taste DNA**: personality, recaps (week/month/year/all), listening clock, week rhythm, discovery/repeat/skip gauges, a year heatmap (tap a day to "take me back"), streaks, milestones, recent shifts, a pan/zoom **taste constellation**, and CSV export.
- **Library**: playlists (grid/list, sort, pin, edit, drag-reorder), Liked Songs, artists, grouped history, saved YouTube playlists, the Hidden list, and **Import from YouTube** (read-only, token kept in memory).
- **Explore/Search**: genre and mood tiles, regional charts, recent searches, instant library matches while you type, cache-first results with a 650 ms debounce, a Top result card, pagination, and pasting a YouTube link plays it.
- **Verified music only** (default): every upload is scored. Topic, VEVO and label channels rank as official; then the artist's own channel; then established channels. Fan uploads (covers, slowed/reverb, edits, Shorts, mashups) are never shown. Turn on "show unverified" per search, or switch it off in Settings.
- **Singer and album pages**: a singer page gathers their songs from every label channel (credited or featured), and an album page rebuilds a film soundtrack from label uploads ("Song | Film | Cast | Singers"), one best version per song.
- **Cinematic lyrics** (full-screen, large serif type, lines pulse with the beat), **About this song** AI notes, and a **docked Now Playing** panel on desktop. Also: a pop-out mini player (Document Picture-in-Picture), hold-to-preview, a heart burst, cover particles, a circular theme reveal and a morphing play/pause icon.
- **AI**: queue chat ("swap the sad ones for upbeat ones"), a daily AI DJ with short spoken intros, AI playlist names and descriptions, voice prompts, and weather/time-aware moods.
- **Import & tidy**: Spotify (data-export ZIP/JSON) and CSV import with matching to official uploads; a resumable importer with undo/redo; a duplicate finder with undo; and a recommendation tuner that learns from what you finish and skip.
- **Phone ↔ web**: settings sync with the app (same `liveRecords` `s_*` records), Continue on phone (QR / Android intent), a send-queue-to-phone option, a list of signed-in devices, and linking Google to an email account to import YouTube playlists.
- **Smart lyrics**: candidates from LRCLIB (exact match plus two searches), NetEase and the version other listeners chose. Each is scored on the real length of the audio release (Apple Music), title, credited artists, timestamps that make sense, the uploader's own lyrics in the video description, and your preferred script. Remixes and reprises are left out. Timing then comes from your fix, other listeners' fixes, or an automatic shift for music videos with intro scenes. **Fix lyrics** lets you nudge ±0.1/0.5 s, tap to sync, ask Arnav AI to line them up (Gemini listens and a robust line fit sets offset and tempo), or choose another version. Fixes are shared. Words rise and sharpen as they're sung; the dock has a wide lyrics sidebar with the translation beside each line.
- **Free music data** (no keys): iTunes Search (albums, tracklists, exact lengths; JSONP from the browser), MusicBrainz (writers, ISRC), Wikidata (film director, cast, year, Wikipedia/IMDb), Deezer (tempo, loudness), NetEase (synced lyrics) and the YouTube description (the app's credits parser plus film credits).
- **Credits pages** (`/credits/<id>`), **Apple Music album pages for any label** (tracklist matched to official uploads: the artist's own album playlist, label uploads, Topic tracks), discography shelves on every singer page.
- **Automix**: a two-deck player for gapless playback, crossfade and smart transitions (fade length per pair; gapless within an album; earlier before a video's outro). Synced with the app's `gapless` / `crossfadeMs` / `smartTransitions`; playlists can have their own style.
- **Look & motion**: player-bar presets (compact, wide, studio with a scrubbable song map), vinyl mode, a WebGL background that follows the song's energy and beat, per-album colour themes across the page, a card-to-cover morph (View Transitions), liquid queue reordering, a 3D album wall (`/wall`), and a monthly **Wrapped** story that exports as a shareable video (`/wrapped`).
- **Taste DNA**: a heatmap of your last 12 months by film/album, era and composer.
- **Everywhere**: ⌘K command palette, keyboard shortcuts (`?`), Media Session (hardware keys / OS media controls), sleep timer, speed, endless radio, unplayable-video rescue, Start radio / Not interested / Don't recommend artist, sharing (`/track/<id>`), PWA manifest, light/dark/auto, artwork-tinted or fixed accent, glass on/off, three motion levels, high contrast, and responsive layouts (sidebar + floating player on desktop; tab bar + mini player on phones).

## Architecture
```
src/                 React 19 + TypeScript + Motion (Vite)
  lib/               Ported domain logic (title parsing, classifier, taste model, recommender,
                     smart playlists, intent engine, session builder, LRC parser, Gemini gateway)
  state/             Zustand stores (library, player, settings, lyrics, ui) + IndexedDB persistence
  player/            YouTube IFrame engine, controller (listening meter, Media Session, radio, rescue)
  services/          Firestore sync (same collections/rules as the app), recommendations, AI sessions
  components/ pages/ UI
server/handlers.ts   One edge API for every host: /api/yt (YouTube, key stays server-side),
                     /api/img (artwork with CORS for colour extraction), /api/lyrics (LRCLIB), /api/health
worker/              Cloudflare Workers entry (static assets + API)
functions/           Cloudflare Pages Functions entry
api/                 Vercel Edge Functions entry
tests/               Unit tests ported from the Android app's core/domain tests
```

### Same backend as the app
| Data | Where | Compatible with the app |
|---|---|---|
| Likes | `users/{uid}/likes/{trackId}` | Same fields and track map (`genres` joined by `\|`), last-write-wins |
| Playlists | `users/{uid}/playlists/{id}` | `kind: ARNAV`, up to 500 YouTube tracks |
| Listening history | `users/{uid}/liveRecords/h_<sha256>` | `SharedListen` JSON, server timestamps, consecutive revisions, tombstones |
| Shared queue | `users/{uid}/liveRecords/q_shared` | Kotlin `Track` JSON; shown as a handoff card, never auto-plays |
| Settings | `users/{uid}/liveRecords/s_<field>` | Same field names and enum values as the app; only settings changed on the web are pushed |
| Web extras | `users/{uid}/liveRecords/w_<family>` (kind `web`) | Playlist automix, lyric fixes, web-only settings, hidden songs / blocked artists / saved YouTube playlists / recent searches, tuner. The app skips unknown kinds. **Needs the updated rules.** |
| Phone backups | `users/{uid}/backups` + `vaultChunks` (read only) | Settings → From your phone brings in older history, searches, hidden songs, blocked artists and the lyrics you curated on the phone |
| AI | Firebase AI Logic (Gemini Developer API) | Same session prompt contract (`session-v4`) |

Hardened rules for both clients live in `firebase/firestore.rules`. `firebase/tests` replays the app's own rule tests plus every web write in the Firebase emulator (likes, tombstones, playlists, history, queue, settings and cross-account denial): all pass. Deploy them with `firebase deploy --only firestore:rules` from a project owner account.

### Edge API additions
`/api/meta` (iTunes, MusicBrainz, Wikidata, Deezer, NetEase; allow-listed and cached in KV), `/api/credits` (one cached credits record per video for everyone), `/api/community` (lyrics version and timing listeners agreed on: median of up to 25 fixes), `/api/known` (artist and film names learned only from YouTube Topic data and Wikidata). `videos`, `search` and `playlistItems` responses carry `arnav`: the shared parse of each title with those names, so every visitor sees the same clean metadata.

## Configuration
| Secret / setting | Where | Notes |
|---|---|---|
| `YOUTUBE_API_KEY` | `npx wrangler secret put YOUTUBE_API_KEY` (Cloudflare) / Project → Environment Variables (Vercel) | Restrict it to **YouTube Data API v3**. Without it, search/charts are paused and listeners can paste their own key in Settings → Sources. |
| `YOUTUBE_ANDROID_PACKAGE` + `YOUTUBE_ANDROID_CERT` | optional | Only if you reuse a key restricted to the Android app. |
| KV `YT_CACHE` | `wrangler.jsonc` | Shared response cache across visitors (saves quota). Forks: create your own namespace. |
| Firebase authorized domain | Firebase console → Authentication → Settings → Authorized domains | Add your web domain for **Google** sign-in (email sign-in works everywhere). |

## Develop
```bash
npm install
npm test            # ported unit tests
npm run build       # typecheck + production build
npx wrangler dev    # SPA + edge API locally on :8787 (put the key in .dev.vars)
```

## Deploy
**Cloudflare Workers** (current host): `npm run deploy:cloudflare`
**Cloudflare Pages**: `npx wrangler pages deploy dist` (uses `functions/api/[[path]].ts`)
**Vercel**: import the repo; `vercel.json` configures the Vite build, SPA rewrites and the edge functions in `api/`.

## Notes
- Playback uses the official YouTube IFrame player with YouTube's controls hidden via its official option. Like the Android *background edition*, Song mode shows artwork while the player runs out of view; that departs from YouTube's API policies, which ask for a visible player.
- No downloading, stream extraction or ad blocking.
- Lyrics come from LRCLIB (community-maintained) or are labelled when written by Arnav AI.
