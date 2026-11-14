import { ls } from './idb'

/** Pages you opened lately (path + name), newest first: the command palette offers them first. */
export interface Place { path: string; label: string; at: number }
const KEY = 'arnav.recentPlaces'
const SKIP = /^\/(welcome|share|track\/)?$/

export function rememberPlace(path: string, label: string) {
  if (!label || SKIP.test(path)) return
  const list = ls.get<Place[]>(KEY, []).filter((p) => p.path !== path)
  ls.set(KEY, [{ path, label: label.slice(0, 80), at: Date.now() }, ...list].slice(0, 8))
}
export const recentPlaces = (): Place[] => ls.get<Place[]>(KEY, [])
