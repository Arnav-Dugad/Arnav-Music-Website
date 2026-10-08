import { handleApi, type ApiEnv } from '../../server/handlers'

/** Cloudflare Pages Functions entry (used when deploying with `wrangler pages deploy dist`). */
export const onRequest: PagesFunction<ApiEnv> = (ctx) => handleApi(ctx.request, ctx.env, (p) => ctx.waitUntil(p))
