import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The edge API (/api/*) runs on Cloudflare Workers/Pages or Vercel. During `vite dev`
// requests are proxied to a local `wrangler dev` (port 8787) when it is running.
export default defineConfig({
  plugins: [react()],
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
