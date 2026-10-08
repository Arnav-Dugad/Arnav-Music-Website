/**
 * Verifies a Firebase Auth ID token on the edge (RS256, Google's rotating public keys), so a
 * signed-in listener's social profile follows them to every device. No Admin SDK needed.
 */
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

let keys: { byKid: Map<string, CryptoKey>; until: number } | null = null

const b64url = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s))) as Record<string, unknown>

async function keyFor(kid: string): Promise<CryptoKey | null> {
  if (!keys || Date.now() > keys.until || !keys.byKid.has(kid)) {
    const r = await fetch(JWKS_URL)
    if (!r.ok) return null
    const body = (await r.json()) as { keys?: (JsonWebKey & { kid?: string })[] }
    const byKid = new Map<string, CryptoKey>()
    for (const k of body.keys ?? []) {
      if (!k.kid) continue
      byKid.set(k.kid, await crypto.subtle.importKey('jwk', { kty: k.kty, n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']))
    }
    const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') ?? '')?.[1] ?? 3600)
    keys = { byKid, until: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 }
  }
  return keys.byKid.get(kid) ?? null
}

export interface FirebaseIdentity { uid: string; name: string | null; picture: string | null }

export async function verifyFirebaseToken(token: string, projectId: string): Promise<FirebaseIdentity | null> {
  const parts = token.split('.')
  if (parts.length !== 3 || token.length > 4096) return null
  try {
    const header = json(parts[0])
    const p = json(parts[1])
    const now = Date.now() / 1000
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null
    if (p.aud !== projectId || p.iss !== `https://securetoken.google.com/${projectId}`) return null
    if (typeof p.exp !== 'number' || p.exp < now || typeof p.iat !== 'number' || p.iat > now + 300) return null
    if (typeof p.sub !== 'string' || !p.sub || p.sub.length > 128) return null
    const key = await keyFor(header.kid)
    if (!key) return null
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
    if (!ok) return null
    return { uid: p.sub, name: typeof p.name === 'string' ? p.name.slice(0, 60) : null, picture: typeof p.picture === 'string' ? p.picture.slice(0, 400) : null }
  } catch {
    return null
  }
}
