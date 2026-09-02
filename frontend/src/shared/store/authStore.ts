import { create } from 'zustand';
import { persist } from 'zustand/middleware';
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER' | 'VIEWER';
  avatarUrl?: string | null;
}
interface AuthState {
  user: User | null;
  accessToken: string | null;
  setAuth: (user: User, accessToken: string) => void;
  logout: () => void;
}
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      setAuth: (user, accessToken) => set({ user, accessToken }),
      logout: () => set({ user: null, accessToken: null }),
    }),
    {
      name: 'auth-storage',
      // Persist both user and accessToken in localStorage
      partialize: (state) => ({ user: state.user, accessToken: state.accessToken }),
    },
  ),
);
