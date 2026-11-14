import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/**
 * Emits /sw.js from pwa/sw.js with this build's version and file list, so the service worker can
 * save every build file for offline use and changes whenever the app does (that's what makes the
 * browser offer the update).
 */
function pwaPlugin(): Plugin {
  return {
    name: 'arnav-pwa',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((f) => f.startsWith('assets/') && !f.endsWith('.map')).map((f) => `/${f}`).sort()
      const version = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12)
      const source = readFileSync(new URL('./pwa/sw.js', import.meta.url), 'utf8')
        .replace("'__VERSION__'", JSON.stringify(version))
        .replace('__ASSETS__', JSON.stringify(assets))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

// The edge API (/api/*) runs on Cloudflare Workers/Pages or Vercel. During `vite dev`
// requests are proxied to a local `wrangler dev` (port 8787) when it is running.
export default defineConfig({
  plugins: [react(), pwaPlugin()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
})
