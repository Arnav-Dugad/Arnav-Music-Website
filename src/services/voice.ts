import { useEffect, useRef, useState } from 'react'

/** Minimal Web Speech API typing (Chrome/Edge/Safari expose it as webkitSpeechRecognition). */
interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => Recognition

function ctor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const voiceSupported = () => typeof window !== 'undefined' && ctor() != null

/** Voice prompts: live transcript while speaking, final text on stop. */
export function useVoice(onFinal: (text: string) => void, onInterim?: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const finalRef = useRef(onFinal)
  const interimRef = useRef(onInterim)
  finalRef.current = onFinal
  interimRef.current = onInterim
  useEffect(() => () => rec.current?.abort(), [])
  const start = () => {
    const C = ctor()
    if (!C) { setError('Voice input isn’t supported in this browser.'); return }
    setError(null)
    const r = new C()
    r.lang = navigator.language || 'en-US'
    r.interimResults = true
    r.continuous = false
    r.maxAlternatives = 1
    let finalText = ''
    r.onresult = (e) => {
      let interim = ''
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i]
        if (res.isFinal) finalText += res[0].transcript
        else interim += res[0].transcript
      }
      interimRef.current?.((finalText + interim).trim())
    }
    r.onerror = (e) => { setError(e.error === 'not-allowed' ? 'Microphone access was blocked.' : e.error === 'no-speech' ? 'Didn’t catch that — try again.' : 'Voice input failed.'); setListening(false) }
    r.onend = () => { setListening(false); if (finalText.trim()) finalRef.current(finalText.trim()) }
    rec.current = r
    setListening(true)
    r.start()
  }
  const stop = () => rec.current?.stop()
  return { listening, error, start, stop, toggle: () => (listening ? stop() : start()), supported: voiceSupported() }
}
