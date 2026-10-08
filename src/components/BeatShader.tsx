import { useEffect, useMemo, useRef, useState } from 'react'
import { usePlayer, useProgress } from '../state/player'
import { useLyrics } from '../state/lyrics'
import { useSettings } from '../state/settings'
import { fetchCredits } from '../lib/meta'
import { songShape } from './Waveform'
import type { Palette } from '../lib/color'
import type { Track } from '../lib/types'

const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`
const FRAG = `precision mediump float;
uniform vec2 res; uniform float time; uniform float kick; uniform float energy; uniform float level;
uniform vec3 c1; uniform vec3 c2; uniform vec3 c3; uniform vec3 cv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; } return v; }
void main() {
  vec2 uv = gl_FragCoord.xy / res; vec2 q = (gl_FragCoord.xy - 0.5 * res) / min(res.x, res.y);
  float t = time * (0.05 + 0.08 * energy);
  float zoom = 1.6 - 0.12 * kick * level;
  vec2 w = vec2(fbm(q * zoom + t), fbm(q * zoom - t + 4.2));
  float n = fbm(q * zoom + 2.4 * w + vec2(t * 0.7, -t * 0.4));
  vec3 col = mix(c1, c2, smoothstep(0.15, 0.85, n));
  col = mix(col, c3, smoothstep(0.45, 1.0, w.x * w.y * 1.6));
  // The beat: a soft bloom of the cover's most vivid colour from the centre.
  float d = length(q);
  col += cv * (0.10 + 0.32 * kick * level) * exp(-d * (2.2 - 0.8 * level));
  col *= 0.72 + 0.38 * level;
  col *= 1.0 - 0.35 * smoothstep(0.4, 1.25, d);
  gl_FragColor = vec4(col, 1.0);
}`

const rgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0.1, 0.1, 0.14]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Typical tempo for the song's energy, when no measured BPM is known. */
const guessBpm = (energy: number) => Math.round(72 + energy * 64)

/**
 * Now Playing's living background: the cover's colours flowing through warped noise, brightening
 * with the song's energy curve at the current moment and kicking on every beat (Deezer's measured
 * tempo when known, else an estimate from the song's energy).
 */
export function BeatShader({ track, palette }: { track: Track; palette: Palette }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const enabled = useSettings((s) => s.beatVisuals && s.motion === 'full')
  const lyrics = useLyrics((s) => s.lyrics)
  const duration = usePlayer((s) => s.duration) || track.durationMs || 0
  const [bpm, setBpm] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const curve = useMemo(() => songShape(track, lyrics, duration || 200_000, 200), [track, lyrics, duration])

  useEffect(() => {
    setBpm(null)
    if (!enabled) return
    let alive = true
    void fetchCredits(track).then((r) => { if (alive && r?.audio?.bpm) setBpm(r.audio.bpm) }).catch(() => undefined)
    return () => { alive = false }
  }, [track.id, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const live = useRef({ palette, curve, bpm, energy: track.energy ?? 0.5, duration })
  live.current = { palette, curve, bpm, energy: track.energy ?? 0.5, duration }

  useEffect(() => {
    if (!enabled) return
    const canvas = ref.current
    const gl = canvas?.getContext('webgl', { antialias: false, premultipliedAlpha: false, powerPreference: 'low-power' })
    if (!canvas || !gl) { setFailed(true); return }
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); return s }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { setFailed(true); return }
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const u = (n: string) => gl.getUniformLocation(prog, n)
    const U = { res: u('res'), time: u('time'), kick: u('kick'), energy: u('energy'), level: u('level'), c1: u('c1'), c2: u('c2'), c3: u('c3'), cv: u('cv') }
    let raf = 0
    let level = 0.5
    const t0 = performance.now()
    const frame = () => {
      raf = requestAnimationFrame(frame)
      if (document.hidden) return
      const scale = 0.5 // render at half resolution: it's a soft background
      const w = Math.max(2, Math.round(canvas.clientWidth * scale))
      const h = Math.max(2, Math.round(canvas.clientHeight * scale))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h) }
      const L = live.current
      const p = usePlayer.getState()
      const pos = useProgress.getState().position
      const target = p.isPlaying && L.duration ? L.curve[Math.min(L.curve.length - 1, Math.floor((pos / L.duration) * L.curve.length))] ?? 0.5 : 0.28
      level += (target - level) * 0.04
      const beatMs = 60_000 / (L.bpm ?? guessBpm(L.energy))
      const phase = ((pos % beatMs) + beatMs) % beatMs / beatMs
      const kick = p.isPlaying ? Math.exp(-phase * 5.5) : 0
      gl.uniform2f(U.res, w, h)
      gl.uniform1f(U.time, (performance.now() - t0) / 1000)
      gl.uniform1f(U.kick, kick)
      gl.uniform1f(U.energy, L.energy)
      gl.uniform1f(U.level, level)
      gl.uniform3fv(U.c1, rgb(L.palette.bg[0]))
      gl.uniform3fv(U.c2, rgb(L.palette.bg[1]))
      gl.uniform3fv(U.c3, rgb(L.palette.bg[2]))
      gl.uniform3fv(U.cv, rgb(L.palette.vivid))
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); gl.getExtension('WEBGL_lose_context')?.loseContext() }
  }, [enabled])

  if (!enabled || failed) return null
  return <canvas ref={ref} className="np-shader" aria-hidden />
}
