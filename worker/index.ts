import { handleApi, type ApiEnv } from '../server/handlers'
export { ListeningRoom } from './room'

interface Env extends ApiEnv {
  ASSETS: Fetcher
  ROOMS: DurableObjectNamespace
}

const ROOM = /^\/api\/room\/([A-Z2-9]{6})$/

/** Cloudflare Workers entry: /api/* is handled here, everything else is the static SPA. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    // Listen together: one Durable Object per room code (WebSocket).
    const room = ROOM.exec(url.pathname)
    if (room) return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request)
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, (p) => ctx.waitUntil(p))
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
