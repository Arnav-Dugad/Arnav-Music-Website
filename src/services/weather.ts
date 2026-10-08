import { create } from 'zustand'
import { fetchWeather, type Weather } from '../lib/aiFeatures'
import { ls } from '../lib/idb'
import { settings, useSettings } from '../state/settings'

interface WeatherState {
  weather: Weather | null
  loading: boolean
  error: string | null
  refresh: (ask?: boolean) => Promise<void>
}

const CACHE = 'arnav.weather'

/** Weather-aware moods. Location is requested only after the listener opts in; cached for an hour. */
export const useWeather = create<WeatherState>()((set, get) => ({
  weather: ls.get<Weather | null>(CACHE, null),
  loading: false,
  error: null,
  async refresh(ask = false) {
    if (!settings().weatherMoods && !ask) return
    const cached = get().weather
    if (cached && Date.now() - cached.at < 3600_000 && !ask) return
    if (!('geolocation' in navigator)) { set({ error: 'Location isn’t available in this browser.' }); return }
    set({ loading: true, error: null })
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { maximumAge: 3600_000, timeout: 10_000, enableHighAccuracy: false }))
      const w = await fetchWeather(pos.coords.latitude, pos.coords.longitude)
      ls.set(CACHE, w)
      set({ weather: w, loading: false })
      if (ask) useSettings.getState().update({ weatherMoods: true })
    } catch (e) {
      const denied = (e as GeolocationPositionError)?.code === 1
      set({ loading: false, error: denied ? 'Location permission was declined.' : 'Weather is unavailable right now.' })
      if (denied) useSettings.getState().update({ weatherMoods: false })
    }
  },
}))

void useWeather.getState().refresh()
