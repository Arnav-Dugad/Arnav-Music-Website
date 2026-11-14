import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
  GoogleAuthProvider, browserLocalPersistence, createUserWithEmailAndPassword, getAuth, linkWithPopup, onAuthStateChanged, reauthenticateWithPopup, unlink,
  sendPasswordResetEmail, setPersistence, signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile,
  getAdditionalUserInfo, type Auth, type User,
} from 'firebase/auth'
import { markNewAccount } from './firebase'
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getFirestore, type Firestore } from 'firebase/firestore'

/**
 * The Firebase SDK (about 200 KB gzipped). Only loaded on demand through `./firebase`, so the
 * first paint never waits for it.
 *
 * The same Firebase project as the Android app (arnav-music-c8ca5): one account, one Firestore.
 * Web config values are public identifiers by design; access is enforced by Firestore rules.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyCUi6hZiiy4k8Vnyet9J8Y4Koj8skIbL6U',
  authDomain: 'arnav-music-c8ca5.firebaseapp.com',
  projectId: 'arnav-music-c8ca5',
  storageBucket: 'arnav-music-c8ca5.firebasestorage.app',
  messagingSenderId: '974076367492',
  appId: '1:974076367492:web:42c9849d791bb02340a8d1',
  measurementId: 'G-056Q6R2ML9',
}

let app: FirebaseApp | null = null
let auth: Auth | null = null
let db: Firestore | null = null

export function firebaseApp(): FirebaseApp {
  if (!app) app = initializeApp(firebaseConfig)
  return app
}

export function firebaseAuth(): Auth {
  if (!auth) {
    auth = getAuth(firebaseApp())
    void setPersistence(auth, browserLocalPersistence).catch(() => undefined)
  }
  return auth
}

export function firestore(): Firestore {
  if (!db) {
    try {
      db = initializeFirestore(firebaseApp(), { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })
    } catch {
      db = getFirestore(firebaseApp())
    }
  }
  return db
}

export function watchAuth(cb: (u: User | null) => void) {
  return onAuthStateChanged(firebaseAuth(), cb)
}

const YT_READONLY = 'https://www.googleapis.com/auth/youtube.readonly'

export async function signInWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  const r = await signInWithPopup(firebaseAuth(), provider)
  markNewAccount(getAdditionalUserInfo(r)?.isNewUser === true)
  return r.user
}


/** True when the signed-in account has Google attached (needed for YouTube import). */
const hasGoogle = () => !!firebaseAuth().currentUser?.providerData.some((p) => p.providerId === 'google.com')

/**
 * Short-lived youtube.readonly token for "Import from YouTube" — kept in memory only.
 * Google accounts re-authenticate (never switches accounts); email accounts get Google
 * linked to the same account first, so data and UID stay the same.
 */
export async function youtubeAccessToken(): Promise<string> {
  const provider = new GoogleAuthProvider()
  provider.addScope(YT_READONLY)
  const a = firebaseAuth()
  const u = a.currentUser
  const email = u?.email
  provider.setCustomParameters(email ? { login_hint: email, prompt: 'consent' } : { prompt: 'consent' })
  const r = !u ? await signInWithPopup(a, provider) : hasGoogle() ? await reauthenticateWithPopup(u, provider) : await linkWithPopup(u, provider)
  const cred = GoogleAuthProvider.credentialFromResult(r)
  if (!cred?.accessToken) throw new Error('Google didn’t grant YouTube access.')
  return cred.accessToken
}

/** Attaches a Google account to the current (email) account — same UID, same library. */
export async function linkGoogle() {
  const u = firebaseAuth().currentUser
  if (!u) throw new Error('Sign in first')
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  const r = await linkWithPopup(u, provider)
  await r.user.reload()
  return r.user
}

export async function unlinkGoogle() {
  const u = firebaseAuth().currentUser
  if (!u) throw new Error('Sign in first')
  if (u.providerData.length < 2) throw new Error('Google is your only sign-in method, so it can’t be removed.')
  return unlink(u, 'google.com')
}

export async function signInEmail(email: string, password: string) {
  markNewAccount(false)
  return (await signInWithEmailAndPassword(firebaseAuth(), email.trim(), password)).user
}

export async function signUpEmail(name: string, email: string, password: string) {
  const u = (await createUserWithEmailAndPassword(firebaseAuth(), email.trim(), password)).user
  markNewAccount(true)
  if (name.trim()) await updateProfile(u, { displayName: name.trim().slice(0, 80) })
  return u
}

export const resetPassword = (email: string) => sendPasswordResetEmail(firebaseAuth(), email.trim())
export const signOutUser = () => signOut(firebaseAuth())
