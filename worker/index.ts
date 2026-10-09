import { handleApi, type ApiEnv } from '../server/handlers'
export { ListeningRoom } from './room'
export { SocialHub } from './social'

interface Env extends ApiEnv {
  ASSETS: Fetcher
  ROOMS: DurableObjectNamespace
  SOCIAL: DurableObjectNamespace
}

const ROOM = /^\/api\/room\/([A-Z2-9]{6})$/

const unavailable = (what: string, e: unknown) => {
  console.error(`[${what}]`, e instanceof Error ? e.stack ?? e.message : e)
  return new Response(JSON.stringify({ error: 'unavailable', message: `${what === 'room' ? 'Listening rooms are' : 'Friends are'} briefly unavailable. Trying again…` }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '3' },
  })
}

/** Cloudflare Workers entry: /api/* is handled here, everything else is the static SPA. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    // Listen together: one Durable Object per room code (WebSocket).
    const room = ROOM.exec(url.pathname)
    if (room) {
      try { return await env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(request) } catch (e) { return unavailable('room', e) }
    }
    if (url.pathname.startsWith('/api/room/')) return new Response(JSON.stringify({ error: 'bad_room' }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } })
    // Friends, presence and the inbox: one social hub.
    if (url.pathname.startsWith('/api/social/')) {
      try { return await env.SOCIAL.get(env.SOCIAL.idFromName('hub')).fetch(request) } catch (e) { return unavailable('social', e) }
    }
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, (p) => ctx.waitUntil(p))
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
