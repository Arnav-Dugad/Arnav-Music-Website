import { create } from 'zustand'

export interface AuthUser {
  uid: string
  displayName: string | null
  email: string | null
  photoURL: string | null
  providers: string[]
}

interface AuthState {
  status: 'loading' | 'signedIn' | 'signedOut'
  user: AuthUser | null
  set: (p: Partial<Pick<AuthState, 'status' | 'user'>>) => void
}

export const useAuth = create<AuthState>()((set) => ({
  status: 'loading',
  user: null,
  set: (p) => set(p),
}))

export const firstName = (u: AuthUser | null) => (u?.displayName ?? u?.email ?? '').split(/[\s@]/)[0] || null
