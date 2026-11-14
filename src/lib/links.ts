/** A YouTube or YouTube Music song link (watch, shorts, embed, youtu.be): group 1 is the video id. */
export const YT_LINK = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/
/** A playlist id in a YouTube link: group 1. */
export const YT_PLAYLIST = /[?&]list=([A-Za-z0-9_-]{12,64})/

/** Where something shared into the app should open: a song, a playlist, or a search. */
export function sharedTarget(text: string): string {
  const song = YT_LINK.exec(text)
  if (song) return `/track/${song[1]}`
  const pl = YT_PLAYLIST.exec(text)
  if (pl && /youtu/.test(text)) return `/playlist/ytpl:${pl[1]}`
  const q = text.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return q ? `/search?q=${encodeURIComponent(q)}` : '/search'
}
