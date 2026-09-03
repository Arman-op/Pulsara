import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export type Toast = {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
};

type ToastState = {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
};

/** How long a toast stays before dismissing itself. */
const TOAST_LIFETIME_MS = 5_000;

/**
 * Ids come from `crypto.randomUUID`, not `Math.random().toString(36)`.
 *
 * The old generator produced seven characters from a non-cryptographic source,
 * and a collision means React reuses a DOM node for a different toast — so
 * dismissing one closes another. It is available in every browser this app
 * supports, over HTTPS or on localhost.
 */
function createId(): string {
  return crypto.randomUUID();
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (toast) => {
    const id = createId();
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));

    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((entry) => entry.id !== id) }));
    }, TOAST_LIFETIME_MS);
  },

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((entry) => entry.id !== id) })),
}));
