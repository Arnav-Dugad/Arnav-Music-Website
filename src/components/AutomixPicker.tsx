import { Icon } from './Icon'
import { usePrefs } from '../state/prefs'
import { defaultAutomix, useSettings, type AutomixStyle } from '../state/settings'

const LABEL: Record<AutomixStyle, string> = { smart: 'Smart', crossfade: 'Crossfade', gapless: 'Gapless', off: 'Off' }

/** Per-playlist automix ("Automix: Smart"). Default follows Settings → Playback. */
export function AutomixPicker({ id }: { id: string }) {
  const own = usePrefs((s) => s.playlistAutomix[id] ?? null)
  const fallback = useSettings((s) => defaultAutomix(s))
  const value = own ?? 'default'
  return (
    <label className={`chip automix-chip ${own ? 'on' : ''}`} title="How songs in this playlist hand over to the next">
      <Icon name="wave" size={14} />
      <span className="automix-label">Automix</span>
      <select value={value} aria-label="Automix for this playlist" onChange={(e) => usePrefs.getState().setPlaylistAutomix(id, e.target.value === 'default' ? null : (e.target.value as AutomixStyle))}>
        <option value="default">Default ({LABEL[fallback]})</option>
        {(['smart', 'crossfade', 'gapless', 'off'] as AutomixStyle[]).map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
      </select>
    </label>
  )
}
