import { generate, noteFallback } from './ai'
import { extractObject } from './intent'
import { artistKey, type Track } from './types'
import { MOODS, type Mood } from './types'

// ── Queue chat ───────────────────────────────────────────────────────────────
export interface QueueEdit {
  remove: number[]
  playNext: number[]
  order?: 'energy-up' | 'energy-down' | 'shuffle' | null
  addQueries: string[]
  reply: string
  usedAi: boolean
}

const describe = (t: Track, i: number) =>
  `${i + 1}. ${t.title} — ${t.artist}${t.energy != null ? ` (energy ${Math.round(t.energy * 100)})` : ''}${t.genres.length ? ` [${t.genres.join(', ')}]` : ''}`

/** On-device understanding of common queue commands (used when Gemini is unavailable). */
export function localQueueEdit(text: string, upcoming: Track[]): QueueEdit {
  const q = text.toLowerCase()
  const edit: QueueEdit = { remove: [], playNext: [], order: null, addQueries: [], reply: '', usedAi: false }
  const sad = /\b(sad|slow|melanchol|heartbreak|depress|emotional|cry)\w*/.test(q)
  const remove = /\b(remove|no more|skip|drop|get rid of|without|less|swap|replace|no)\b/.test(q)
  const artistMatch = upcoming.map((t, i) => ({ t, i })).filter(({ t }) => q.includes(t.artist.toLowerCase().split(',')[0].trim()) && t.artist.length > 2)
  if (remove && artistMatch.length) {
    edit.remove = artistMatch.map((x) => x.i)
    edit.reply = `Removed ${artistMatch.length} ${artistMatch.length === 1 ? 'song' : 'songs'} by ${artistMatch[0].t.artist.split(',')[0]}.`
  } else if (sad && remove) {
    edit.remove = upcoming.map((t, i) => ({ t, i })).filter(({ t }) => (t.energy ?? 0.5) < 0.4 || /sad|broken|cry|alone|tears/i.test(t.title)).map((x) => x.i)
    if (/\bswap|replace\b/.test(q)) edit.addQueries = ['upbeat feel good songs']
    edit.reply = edit.remove.length ? `Took out ${edit.remove.length} slower, sadder songs${edit.addQueries.length ? ' and added upbeat ones' : ''}.` : 'Nothing in the queue sounds sad.'
  } else if (/\b(more energ|hype|pump|faster|upbeat|party|build)/.test(q)) {
    edit.order = 'energy-up'
    edit.reply = 'Reordered so the energy builds.'
  } else if (/\b(calm|chill|relax|wind down|slower|softer|mellow)/.test(q)) {
    edit.order = 'energy-down'
    edit.reply = 'Reordered so it winds down.'
  } else if (/\bshuffle|mix it up\b/.test(q)) {
    edit.order = 'shuffle'
    edit.reply = 'Shuffled what’s next.'
  } else if (/\b(add|more|play)\b/.test(q)) {
    const m = q.replace(/^(please\s+)?(add|play|more|give me)\s+(some\s+)?/, '').trim()
    if (m) { edit.addQueries = [`${m} songs`]; edit.reply = `Adding ${m}.` }
  }
  if (!edit.reply) edit.reply = 'Try “no more slow songs”, “more energy”, “remove Drake” or “add 90s Bollywood”.'
  return edit
}

export async function queueEdit(text: string, current: Track | null, upcoming: Track[]): Promise<QueueEdit> {
  const list = upcoming.slice(0, 40)
  const prompt = `You edit a music queue for the listener. Now playing: ${current ? `${current.title} — ${current.artist}` : 'nothing'}.
Up next (numbered):
${list.map(describe).join('\n') || '(empty)'}
Request: "${text.slice(0, 200).replace(/"/g, "'")}"
Respond ONLY with JSON: {"remove":[numbers to remove],"playNext":[numbers to move right after the current song],"order":"energy-up"|"energy-down"|"shuffle"|null,"addQueries":[0-2 short YouTube search phrases for SINGLE songs to add, never mix/playlist/jukebox],"reply":"one short friendly sentence describing what you changed"}
Use only numbers from the list. If the request is unclear, change nothing and ask in "reply".`
  const r = await generate(prompt, 'queue-edit-v1', { json: true, maxOutputTokens: 500, cacheTtlMs: 60_000 })
  if (r.ok) {
    try {
      const o = JSON.parse(extractObject(r.text) ?? '{}') as Partial<QueueEdit>
      const nums = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= list.length).map((n) => n - 1) : [])
      return {
        remove: nums(o.remove), playNext: nums(o.playNext),
        order: o.order === 'energy-up' || o.order === 'energy-down' || o.order === 'shuffle' ? o.order : null,
        addQueries: Array.isArray(o.addQueries) ? o.addQueries.filter((x): x is string => typeof x === 'string' && !/\b(mix|playlist|jukebox|nonstop|mashup)\b/i.test(x)).slice(0, 2) : [],
        reply: typeof o.reply === 'string' ? o.reply.slice(0, 200) : 'Done.',
        usedAi: true,
      }
    } catch { /* fall through */ }
  }
  noteFallback()
  return localQueueEdit(text, list)
}

// ── AI DJ ────────────────────────────────────────────────────────────────────
export async function djIntro(prev: Track | null, next: Track, hour = new Date().getHours()): Promise<string> {
  const part = hour < 5 ? 'late night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night'
  const prompt = `You are Arnav, a warm, concise radio DJ. In ONE or TWO short sentences (max 28 words total), introduce the next song for a ${part} listener.
${prev ? `Previous: "${prev.title}" by ${prev.artist}.` : ''} Next: "${next.title}" by ${next.artist}${next.album ? ` from ${next.album}` : ''}.
Only state facts you are sure of; no made-up trivia, no emojis, no hashtags. Plain text.`
  const r = await generate(prompt, 'dj-v1', { maxOutputTokens: 120, cacheTtlMs: 30 * 86_400_000, skipThrottle: true })
  if (r.ok) return r.text.trim().replace(/^"|"$/g, '').slice(0, 220)
  return prev ? `That was ${prev.title}. Up next, ${next.artist} with ${next.title}.` : `Here's ${next.title} by ${next.artist}.`
}

// ── Playlist naming ─────────────────────────────────────────────────────────
export async function namePlaylist(tracks: Track[]): Promise<{ name: string; description: string; usedAi: boolean }> {
  const sample = tracks.slice(0, 30).map((t) => `${t.title} — ${t.artist}`).join('\n')
  const r = await generate(`Name this playlist. Songs:\n${sample}\nRespond ONLY with JSON {"name": string (2-4 evocative words, no quotes, no emojis), "description": string (one sentence, max 18 words)}.`,
    'playlist-name-v1', { json: true, maxOutputTokens: 200 })
  if (r.ok) {
    try {
      const o = JSON.parse(extractObject(r.text) ?? '{}') as { name?: string; description?: string }
      if (o.name) return { name: o.name.slice(0, 60), description: (o.description ?? '').slice(0, 200), usedAi: true }
    } catch { /* fall back */ }
  }
  const artists = [...new Set(tracks.map((t) => t.artist.split(',')[0].trim()))].slice(0, 3)
  const genre = tracks.flatMap((t) => t.genres)[0]
  return { name: genre ? `${genre[0].toUpperCase()}${genre.slice(1)} rotation` : `${artists[0] ?? 'My'} & more`, description: artists.length ? `With ${artists.join(', ')}.` : '', usedAi: false }
}

// ── About this song ─────────────────────────────────────────────────────────
export async function songNotes(track: Track, lyrics: string[]): Promise<{ text: string; usedAi: boolean } | null> {
  const excerpt = lyrics.filter((l) => l.trim()).slice(0, 24).join('\n')
  const r = await generate(`Write a short note (3-4 sentences, max 90 words) about the song "${track.title}" by ${track.artist}${track.album ? ` (${track.album})` : ''}: what the lyrics are about and the feeling they carry.
${excerpt ? `Lyrics excerpt for context:\n${excerpt}\n` : ''}Interpret the lyrics; don't quote more than a few words. If you aren't sure of facts (release, credits), leave them out. Plain text, no markdown.`,
    'song-notes-v1', { maxOutputTokens: 400, cacheTtlMs: 180 * 86_400_000, skipThrottle: true })
  return r.ok ? { text: r.text.trim(), usedAi: true } : null
}

// ── A film's music ──────────────────────────────────────────────────────────
export interface FilmMusic {
  intro: string
  composers: { name: string; works: { title: string; year: number | null }[] }[]
  similar: { title: string; year: number | null; composer: string | null; why: string }[]
}

/** "Ask Arnav AI about this film's music": the composer's other work and soundtracks like it. */
export async function filmMusic(film: { title: string; year: number | null; composers: string[]; director: string | null; songs: string[] }): Promise<FilmMusic | null> {
  const facts = [
    `Film: ${film.title}${film.year ? ` (${film.year})` : ''}`,
    film.composers.length ? `Music by: ${film.composers.join(', ')}` : null,
    film.director ? `Directed by: ${film.director}` : null,
    film.songs.length ? `Songs: ${film.songs.slice(0, 12).join('; ')}` : null,
  ].filter(Boolean).join('\n')
  const prompt = `You are a film-music expert. Using these facts:
${facts}

Write JSON only, with real, well-known titles you are confident exist (skip anything you're unsure of):
{"intro":"2-3 sentences about this soundtrack's sound and place, max 70 words",
 "composers":[{"name":"composer","works":[{"title":"other film or album they scored","year":2015}]}],
 "similar":[{"title":"film soundtrack with a similar feel","year":2014,"composer":"its composer","why":"max 10 words"}]}
At most 6 works per composer and 6 similar soundtracks. No markdown.`
  const r = await generate(prompt, 'film-music-v1', { json: true, maxOutputTokens: 1400, temperature: 0.3, cacheTtlMs: 180 * 86_400_000, skipThrottle: true })
  if (!r.ok) return null
  let o: Partial<FilmMusic> | null = null
  try { const raw = extractObject(r.text); o = raw ? (JSON.parse(raw) as Partial<FilmMusic>) : null } catch { return null }
  if (!o || typeof o.intro !== 'string') return null
  const year = (y: unknown) => (typeof y === 'number' && y > 1900 && y < 2100 ? y : null)
  return {
    intro: o.intro.slice(0, 600),
    composers: (Array.isArray(o.composers) ? o.composers : []).slice(0, 3).map((c) => ({
      name: String(c?.name ?? '').slice(0, 80),
      works: (Array.isArray(c?.works) ? c.works : []).slice(0, 6).map((w) => ({ title: String(w?.title ?? '').slice(0, 100), year: year(w?.year) })).filter((w) => w.title),
    })).filter((c) => c.name),
    similar: (Array.isArray(o.similar) ? o.similar : []).slice(0, 6).map((x) => ({ title: String(x?.title ?? '').slice(0, 100), year: year(x?.year), composer: x?.composer ? String(x.composer).slice(0, 80) : null, why: String(x?.why ?? '').slice(0, 80) })).filter((x) => x.title),
  }
}

// ── Weather & time moods (Open-Meteo, no key; location only with consent) ─────
export interface Weather { code: number; temp: number; isDay: boolean; label: string; mood: Mood; moment: string; at: number }

export function weatherMood(code: number, temp: number, isDay: boolean, hour = new Date().getHours()): Pick<Weather, 'label' | 'mood' | 'moment'> {
  const rain = (code >= 51 && code <= 67) || (code >= 80 && code <= 82)
  const storm = code >= 95
  const snow = (code >= 71 && code <= 77) || code === 85 || code === 86
  const fog = code === 45 || code === 48
  const clear = code <= 1
  if (storm) return { label: 'Stormy', mood: 'CINEMATIC', moment: 'night_drive' }
  if (rain) return { label: 'Rainy', mood: 'MELANCHOLY', moment: 'rain' }
  if (snow) return { label: 'Snowy', mood: 'CALM', moment: 'calm' }
  if (fog) return { label: 'Foggy', mood: 'CHILL', moment: 'late_night' }
  if (!isDay || hour >= 22 || hour < 5) return { label: clear ? 'Clear night' : 'Night', mood: 'NIGHT', moment: hour >= 22 || hour < 5 ? 'late_night' : 'night_drive' }
  if (clear && hour >= 17) return { label: 'Golden hour', mood: 'UPBEAT', moment: 'golden_hour' }
  if (temp >= 30) return { label: 'Hot', mood: 'PARTY', moment: 'high_energy' }
  if (clear) return { label: 'Sunny', mood: 'UPBEAT', moment: 'golden_hour' }
  return { label: 'Cloudy', mood: 'CHILL', moment: 'deep_focus' }
}

export async function fetchWeather(lat: number, lon: number): Promise<Weather> {
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=weather_code,temperature_2m,is_day`)
  if (!r.ok) throw new Error('weather')
  const j = (await r.json()) as { current?: { weather_code?: number; temperature_2m?: number; is_day?: number } }
  const code = j.current?.weather_code ?? 2
  const temp = j.current?.temperature_2m ?? 20
  const isDay = (j.current?.is_day ?? 1) === 1
  return { code, temp, isDay, ...weatherMood(code, temp, isDay), at: Date.now() }
}

export const moodLabel = (m: Mood) => MOODS[m].label
export const sameArtist = (a: Track, b: Track) => artistKey(a.artist) === artistKey(b.artist)
