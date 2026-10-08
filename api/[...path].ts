import { handleApi } from '../server/handlers'

declare const process: { env: Record<string, string | undefined> }

/** Vercel Edge Function for every /api/* route — same handler as Cloudflare. (No KV on Vercel: caching falls back to the CDN.) */
export const config = { runtime: 'edge' }

export default function handler(request: Request): Promise<Response> {
  return handleApi(request, {
    YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
    YOUTUBE_ANDROID_PACKAGE: process.env.YOUTUBE_ANDROID_PACKAGE,
    YOUTUBE_ANDROID_CERT: process.env.YOUTUBE_ANDROID_CERT,
  })
}
