/**
 * Link previews: when a song, public playlist, listening room or invite link is shared in a chat
 * app, the page it fetches carries that thing's title, description and artwork (Open Graph and
 * Twitter tags) instead of the generic app card. The app itself is unchanged; only the HTML head.
 */
interface Preview { title: string; description: string; image?: string | null; type?: string }

const SONG = /^\/track\/([A-Za-z0-9_-]{11})\/?$/
const PLAYLIST = /^\/p\/([A-Z2-9]{10})\/?$/
const ROOM = /^\/together\/([A-Z2-9]{6})\/?$/
const INVITE = /^\/add\/([A-Z0-9]{6,12})\/?$/

const SAFE_IMG = /^https:\/\/(i\d?\.ytimg\.com|is\d-ssl\.mzstatic\.com|yt3\.ggpht\.com|lh3\.googleusercontent\.com)\//

/** Which preview a path gets (null: the normal app card). */
export async function previewFor(url: URL, social: DurableObjectNamespace | undefined): Promise<Preview | null> {
  const song = SONG.exec(url.pathname)
  if (song) {
    // YouTube's oEmbed: free (no API quota), cached a day at the edge.
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${song[1]}`)}`, { cf: { cacheTtl: 86_400, cacheEverything: true } } as RequestInit).catch(() => null)
    const o = r?.ok ? await r.json().catch(() => null) as { title?: string; author_name?: string } | null : null
    if (!o?.title) return null
    const by = (o.author_name ?? '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '')
    return { title: o.title, description: by ? `${by} · Listen on Arnav Music, with synced lyrics` : 'Listen on Arnav Music, with synced lyrics', image: `https://i.ytimg.com/vi/${song[1]}/hqdefault.jpg`, type: 'music.song' }
  }
  const pl = PLAYLIST.exec(url.pathname)
  if (pl && social) {
    const r = await social.get(social.idFromName('hub')).fetch(new Request(`${url.origin}/api/social/pl/${pl[1]}`)).catch(() => null)
    const d = r?.ok ? await r.json().catch(() => null) as { playlist?: { title: string; description: string | null; count: number; art: string | null; tracks?: { artworkUrl?: string | null }[] }; owner?: { name: string } } | null : null
    if (!d?.playlist) return null
    const p = d.playlist
    const art = p.art ?? p.tracks?.find((t) => t.artworkUrl)?.artworkUrl ?? null
    return { title: p.title, description: `Playlist by ${d.owner?.name ?? 'a listener'} · ${p.count} songs${p.description ? ` — ${p.description}` : ''}`, image: art && SAFE_IMG.test(art) ? art : null, type: 'music.playlist' }
  }
  const room = ROOM.exec(url.pathname)
  if (room) return { title: 'Listen together on Arnav Music', description: `Join room ${room[1]} — everyone hears the same song at the same moment, with reactions.` }
  if (INVITE.test(url.pathname)) return { title: 'Add me on Arnav Music', description: 'Open the link and we’re friends: see what each other is playing and listen along.' }
  return null
}

/** The app's index.html with the preview's tags in place of the generic ones. */
export function withPreview(res: Response, p: Preview, pageUrl: string): Response {
  const set = (prop: string, value: string | null | undefined) => (el: Element) => { if (value) el.setAttribute('content', value) }
  let hasImage = false
  const out = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(`${p.title} · Arnav Music`) } })
    .on('meta[property="og:title"]', { element: set('og:title', p.title) })
    .on('meta[property="og:description"]', { element: set('og:description', p.description) })
    .on('meta[name="description"]', { element: set('description', p.description) })
    .on('meta[property="og:type"]', { element: set('og:type', p.type ?? 'website') })
    .on('meta[property="og:image"]', { element(el) { hasImage = true; if (p.image) el.setAttribute('content', p.image) } })
    .on('head', {
      element(el) {
        // Tags the page doesn't have yet go at the end of <head>.
        el.onEndTag((end) => {
          const tags = [
            `<meta property="og:url" content="${escapeAttr(pageUrl)}" />`,
            `<meta name="twitter:card" content="${p.image ? 'summary_large_image' : 'summary'}" />`,
            `<meta name="twitter:title" content="${escapeAttr(p.title)}" />`,
            `<meta name="twitter:description" content="${escapeAttr(p.description)}" />`,
            ...(p.image ? [`<meta name="twitter:image" content="${escapeAttr(p.image)}" />`] : []),
            ...(p.image && !hasImage ? [`<meta property="og:image" content="${escapeAttr(p.image)}" />`] : []),
          ]
          end.before(tags.join(''), { html: true })
        })
      },
    })
    .transform(res)
  const headers = new Headers(out.headers)
  headers.set('cache-control', 'no-cache')
  return new Response(out.body, { status: out.status, headers })
}

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
