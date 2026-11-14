import type { User } from 'firebase/auth'
import { useAuth } from '../state/auth'

/**
 * Account actions, without the Firebase SDK on the first-paint path: the SDK (`./firebaseSdk`,
 * about 200 KB gzipped) loads the first time something here is used, or when sync starts.
 */
let sdkPromise: Promise<typeof import('./firebaseSdk')> | null = null
export function loadFirebase() {
  if (!sdkPromise) sdkPromise = import('./firebaseSdk').catch((e) => { sdkPromise = null; throw e })
  return sdkPromise
}

/** Starts the SDK download early (sign-in sheet opened), so popups open right on the tap. */
export function preloadFirebase() { void loadFirebase().catch(() => undefined) }

/**
 * Whether this browser was signed in last time: Firebase keeps the session in localStorage
 * (browserLocalPersistence), so a returning account's sync starts at once.
 */
export function hadSession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith('firebase:authUser:')) return true
  } catch { /* storage blocked */ }
  return false
}

export const signInWithGoogle = (): Promise<User> => loadFirebase().then((m) => m.signInWithGoogle())
export const youtubeAccessToken = (): Promise<string> => loadFirebase().then((m) => m.youtubeAccessToken())
export const linkGoogle = (): Promise<User> => loadFirebase().then((m) => m.linkGoogle())
export const unlinkGoogle = (): Promise<User> => loadFirebase().then((m) => m.unlinkGoogle())
export const signInEmail = (email: string, password: string): Promise<User> => loadFirebase().then((m) => m.signInEmail(email, password))
export const signUpEmail = (name: string, email: string, password: string): Promise<User> => loadFirebase().then((m) => m.signUpEmail(name, email, password))
export const resetPassword = (email: string): Promise<void> => loadFirebase().then((m) => m.resetPassword(email))
export const signOutUser = (): Promise<void> => loadFirebase().then((m) => m.signOutUser())

/** True when the signed-in account has Google attached (needed for YouTube import). */
export const hasGoogle = () => !!useAuth.getState().user?.providers.includes('google.com')

/**
 * Whether the account that just signed in was created a moment ago (it then gets the short
 * "what do you like" setup) — an existing account goes straight to its library.
 */
export function markNewAccount(isNew: boolean) {
  try { if (isNew) sessionStorage.setItem('arnav.newAccount', '1'); else sessionStorage.removeItem('arnav.newAccount') } catch { /* storage blocked */ }
}
export const isNewAccount = () => { try { return sessionStorage.getItem('arnav.newAccount') === '1' } catch { return false } }

/** Human copy for Firebase Auth error codes. */
export function authMessage(e: unknown): string {
  const code = (e as { code?: string })?.code ?? ''
  const map: Record<string, string> = {
    'auth/invalid-credential': 'That email and password don’t match.',
    'auth/wrong-password': 'That email and password don’t match.',
    'auth/user-not-found': 'No account uses that email yet.',
    'auth/email-already-in-use': 'An account already uses that email — sign in instead.',
    'auth/weak-password': 'Use at least 6 characters.',
    'auth/invalid-email': 'That email doesn’t look right.',
    'auth/popup-closed-by-user': 'The Google window was closed before finishing.',
    'auth/cancelled-popup-request': 'Another sign-in window is already open.',
    'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for this site.',
    'auth/unauthorized-domain': 'Google sign-in isn’t enabled for this web address yet. Use email, or add this domain in Firebase → Authentication → Settings → Authorized domains.',
    'auth/network-request-failed': 'You appear to be offline.',
    'auth/too-many-requests': 'Too many attempts. Try again in a few minutes.',
    'auth/operation-not-allowed': 'This sign-in method isn’t enabled in Firebase.',
    'auth/credential-already-in-use': 'That Google account already belongs to another Arnav Music account. Sign in with Google instead, or pick a different Google account.',
    'auth/provider-already-linked': 'A Google account is already linked.',
    'auth/requires-recent-login': 'For security, sign out and sign in again, then retry.',
    'auth/user-mismatch': 'Pick the same Google account you signed in with.',
  }
  return map[code] ?? (e instanceof Error ? e.message.replace(/^Firebase: /, '') : 'Something went wrong.')
}
