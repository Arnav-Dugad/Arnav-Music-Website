import type { Track } from './types'
import { artistKey } from './types'
import { normalize } from './query'

/**
 * "Verified music only": official uploads first, fan uploads out.
 *   3 = official: YouTube "- Topic" art tracks, VEVO, record labels
 *   2 = the artist's own channel (channel name matches a credited artist)
 *   1 = an established channel (≥ 250k subscribers, a well-watched upload, not a fan lyric/edit upload)
 *   0 = unverified (shown only when the listener turns verified-only off)
 *  -1 = fan content (covers, karaoke, reactions, slowed/reverb, 8D, nightcore, edits, Shorts)
 */
export type Trust = -1 | 0 | 1 | 2 | 3

const TOPIC = /\s-\s*Topic$/i
const VEVO = /VEVO$/i

/** Record labels and official music distributors (global + India + K-pop + electronic). */
const LABELS = new RegExp(
  '^(' + [
    // India
    't-series', 'tseries', 'yrf', 'yrf music', 'sony music india', 'sony music south', 'zee music company', 'zee music', 'tips official', 'tips music', 'tips films',
    'saregama', 'saregama music', 'aditya music', 'lahari music', 'lahari', 'speed records', 'times music', 'venus', 'eros now music', 'eros now', 'shemaroo',
    'think music india', 'think music', 'sun music', 'mango music', 'junglee music', 'desi music factory', 'white hill music', 'saga music', 'universal music india',
    'sony music', 'muzik247', 'divo music', 'sony music tamil', 'sony music telugu', 'sony music malayalam', 'u1 records', 'saregama tamil', 'saregama telugu',
    'zee music south', 'anand audio', 'jhankar music', 'geet mp3', 'speed records punjabi', 'humble music', 'sky digital', 'vyrl originals', 'vyrl punjabi', 'vyrl haryanvi',
    'amara muzik', 'ishtar music', 'goldmines gaane sune ansune', 'goldmines', 'rajshri', 'ultra bollywood', 'pen music', 'jjust music', 'azadi records', 'mass appeal india',
    // Global majors and big independents
    'universal music', 'umg', 'sony music entertainment', 'warner music', 'warner records', 'atlantic records', 'republic records', 'interscope', 'columbia records', 'rca records',
    'capitol records', 'def jam', 'island records', 'epic records', 'elektra records', 'parlophone', 'virgin records', 'emi', 'big machine', 'mca records', 'geffen records',
    'motown', 'xl recordings', 'sub pop', 'domino recording', 'rough trade', '4ad', 'matador records', 'xo', 'top dawg entertainment', 'quality control music', 'young money',
    'mercury records', 'polydor', 'decca', 'deutsche grammophon', 'nonesuch', 'concord', 'ninja tune', 'warp records', 'mad decent', 'spinnin records', 'monstercat',
    'armada music', 'ultra music', 'anjunabeats', 'owsla', 'mau5trap', 'defected records', 'ministry of sound', 'dim mak', 'hexagon', 'revealed recordings',
    // K-pop / J-pop / Latin
    'hybe labels', 'bighit music', 'big hit labels', 'smtown', 'jyp entertainment', 'yg entertainment', '1thek', 'stone music entertainment', 'genie music', 'mnet k-pop',
    'starship', 'cube entertainment', 'pledis', 'avex', 'sony music japan', 'universal music japan', 'rimas', 'dale play', 'sony music latin', 'universal music latino',
    // Official aggregators
    '88rising', 'colors', 'genius', 'npr music', 'tiny desk', 'vevo', 'honda stage',
  ].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')( music| records| official| india)?$',
  'i',
)

/** Fan content: always excluded unless the listener searched for it explicitly. */
const FAN = [
  ['cover', /\b(cover|covered by|covers?\s+by|dance\s+cover|piano\s+cover|guitar\s+cover|acoustic\s+cover|female\s+version|male\s+version|unplugged\s+cover)\b/i],
  ['karaoke', /\b(karaoke|instrumental\s+with\s+lyrics|sing\s*along|minus\s*one)\b/i],
  ['reaction', /\b(reaction|reacts?|reacting|first\s+time\s+(hearing|listening))\b/i],
  ['tutorial', /\b(tutorial|lesson|how\s+to\s+(play|sing)|chords|tabs|sheet\s+music|synthesia)\b/i],
  ['slowed', /\b(slowed|reverb|sped\s*up|speed\s*up|nightcore|8d(\s+audio)?|bass\s+boosted|daycore|lofi\s+flip|lo-?fi\s+version)\b/i],
  ['edit', /\b(fan\s*made|fanmade|amv|fmv|edit\s+audio|whatsapp\s+status|status\s+video|ringtone|tiktok\s+version|#shorts|shorts)\b/i],
  ['parody', /\b(parody|spoof|tribute|mashup|medley|remake\s+by|recreated\s+by)\b/i],
] as const

/** Fan lyric channels ("Artist - Song (Lyrics)") are fine when the channel is official. */
const LYRIC_UPLOAD = /[([]\s*(lyrics?|lyric\s+video|letra|tradução|testo)\s*[)\]]|\blyrics\b/i

function channelBase(channel: string): string {
  return normalize(channel.replace(TOPIC, '').replace(VEVO, '').replace(/\b(official|music|tv|channel|records|band|hq|vevo)\b/gi, ' '))
    .replace(/\s+/g, '')
}

function artistKeys(t: Pick<Track, 'artist' | 'credits'>): string[] {
  return [t.artist, t.credits ?? '']
    .join(',')
    .split(/,|&|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+and\s+/i)
    .map((s) => artistKey(s))
    .filter((k) => k.length >= 2)
}

/** Same name, allowing a channel that adds or drops a surname ("Arijit" / "Arijit Singh"), never "Prem" / "Prem Factory". */
function sameName(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 6 && long.startsWith(short) && short.length / long.length >= 0.6
}

/** The credited artist this upload's channel belongs to (the artist's own channel), if any. */
export function channelArtist(t: Pick<Track, 'artist' | 'channelTitle'> & { artistFromChannel?: boolean }): string | null {
  if (t.artistFromChannel || !t.channelTitle) return null
  const base = channelBase(t.channelTitle)
  if (base.length < 2) return null
  return t.artist.split(/,|&|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+/i).map((s) => s.trim()).find((n) => sameName(artistKey(n).replace(/\s+/g, ''), base)) ?? null
}

export function fanKind(title: string, query = ''): string | null {
  const q = query.toLowerCase()
  for (const [kind, re] of FAN) {
    if (re.test(title) && !re.test(q)) return kind
  }
  return null
}

export interface ChannelStat { subs: number | null; hidden?: boolean }

/** Scores an upload. [rawTitle] is the original YouTube title (before parsing). */
export function trustOf(t: Pick<Track, 'artist' | 'credits' | 'channelTitle' | 'views' | 'title'> & { rawTitle?: string | null; artistFromChannel?: boolean }, stat?: ChannelStat | null, query = ''): Trust {
  const raw = t.rawTitle ?? t.title
  if (fanKind(raw, query)) return -1
  const ch = (t.channelTitle ?? '').trim()
  if (!ch) return 0
  if (TOPIC.test(ch) || VEVO.test(ch.replace(/\s+/g, '')) || LABELS.test(ch.trim())) return 3
  // An artist channel counts only when the title itself names the artist (else the channel "matches itself").
  if (channelArtist({ artist: t.artist, channelTitle: ch, artistFromChannel: t.artistFromChannel })) return 2
  if (stat?.subs != null && stat.subs >= 250_000 && (t.views ?? 0) >= 100_000 && !LYRIC_UPLOAD.test(raw)) return 1
  return 0
}

export const isOfficial = (t: Track) => (t.trust ?? 0) >= 2

/** Tracks that pass "verified music only". Tracks with no trust data (older caches, cloud) pass. */
export function passesVerified(t: Track, verifiedOnly: boolean): boolean {
  if (t.trust === -1) return false
  if (!verifiedOnly) return true
  return t.trust == null || t.trust >= 1
}

export function splitVerified(tracks: Track[], verifiedOnly: boolean): { shown: Track[]; hidden: Track[] } {
  const shown: Track[] = []
  const hidden: Track[] = []
  for (const t of tracks) (passesVerified(t, verifiedOnly) ? shown : hidden).push(t)
  // Official uploads first, keeping the original order within each level.
  shown.sort((a, b) => (b.trust ?? 1) - (a.trust ?? 1))
  return { shown, hidden }
}

/** Does this track credit [name] (lead artist, featured artist or credited singer)? */
export function credited(t: Pick<Track, 'artist' | 'credits' | 'channelTitle'>, name: string): boolean {
  const key = artistKey(name)
  if (!key) return false
  if (artistKeys(t).includes(key)) return true
  return !!t.channelTitle && channelBase(t.channelTitle) === key.replace(/\s+/g, '')
}
