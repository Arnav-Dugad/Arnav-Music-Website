import { handleApi, type ApiEnv } from '../server/handlers'

interface Env extends ApiEnv {
  ASSETS: Fetcher
}

/** Cloudflare Workers entry: /api/* is handled here, everything else is the static SPA. */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, (p) => ctx.waitUntil(p))
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
