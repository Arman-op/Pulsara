import { create } from 'zustand';
import type { AuthUser } from '../api/types';

/**
 * Session state.
 *
 * The access token is held **in memory only**. It was previously written to
 * `localStorage` by Zustand's `persist` middleware, which meant any script that
 * ran on the page — an XSS payload, a compromised dependency, a malicious
 * browser extension — could read it and use it against the API.
 *
 * Nothing is persisted at all now. The refresh token lives in an HttpOnly
 * cookie the browser sends automatically and JavaScript cannot read, so on page
 * load the client asks the API to mint a fresh access token from it. That
 * exchange is what "staying signed in" means here, and it survives a reload
 * without ever putting a credential where script can reach it.
 *
 * The cost is a round trip before the first render; `status` exists so the app
 * can show a splash instead of flashing the login page at an already
 * authenticated user.
 */

export type SessionStatus =
  /** The initial refresh attempt has not finished. */
  'bootstrapping' | 'authenticated' | 'anonymous';

type AuthState = {
  user: AuthUser | null;
  accessToken: string | null;
  status: SessionStatus;
  setSession: (user: AuthUser, accessToken: string) => void;
  /** Replaces only the token, after a silent refresh. */
  setAccessToken: (accessToken: string) => void;
  updateUser: (patch: Partial<AuthUser>) => void;
  clearSession: () => void;
  markAnonymous: () => void;
};

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  accessToken: null,
  status: 'bootstrapping',

  setSession: (user, accessToken) => set({ user, accessToken, status: 'authenticated' }),

  setAccessToken: (accessToken) => set({ accessToken }),

  updateUser: (patch) =>
    set((state) => (state.user ? { user: { ...state.user, ...patch } } : state)),

  clearSession: () => set({ user: null, accessToken: null, status: 'anonymous' }),

  markAnonymous: () => set({ status: 'anonymous' }),
}));
