import { X } from 'lucide-react';
import { useToastStore } from '../store/toastStore';

/**
 * Transient notifications.
 *
 * Extracted from App.tsx, where it was defined inline. `role="status"` with
 * `aria-live="polite"` means a screen reader announces a toast when it appears;
 * without it, the only feedback for "profile saved" is a visual flash that a
 * non-sighted user never receives.
 */
const TONE: Record<string, string> = {
  success: 'bg-success/10 border-success/30 text-success',
  error: 'bg-danger/10 border-danger/30 text-danger',
  warning: 'bg-warning/10 border-warning/30 text-warning',
  info: 'bg-surface/85 border-border text-white',
};

export function ToastViewport() {
  const toasts = useToastStore((store) => store.toasts);
  const removeToast = useToastStore((store) => store.removeToast);

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-full max-w-sm"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`p-4 rounded-xl border backdrop-blur-xl shadow-xl flex justify-between items-start transition-all duration-300 animate-in slide-in-from-bottom-5 ${
            TONE[toast.type] ?? TONE.info
          }`}
        >
          <div className="min-w-0">
            <h4 className="font-semibold text-sm">{toast.title}</h4>
            {toast.message && (
              <p className="text-xs text-muted mt-1 break-words">{toast.message}</p>
            )}
          </div>
          <button
            onClick={() => removeToast(toast.id)}
            className="ml-4 text-muted hover:text-white transition-colors shrink-0"
            aria-label="Dismiss notification"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
