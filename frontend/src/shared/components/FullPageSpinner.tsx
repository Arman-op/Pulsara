import { Loader2 } from 'lucide-react';

/** Shown while the session is being restored, before the first render. */
export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="w-7 h-7 animate-spin text-accent" />
      {label && <p className="text-sm text-muted">{label}</p>}
    </div>
  );
}
