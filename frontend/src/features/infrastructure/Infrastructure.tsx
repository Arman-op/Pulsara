import * as React from 'react';
import { cn } from '../../shared/utils/cn';
import { DEFAULT_WINDOW_MINUTES, InfraChart } from './components/InfraChart';
import { SystemHealthMap } from './components/SystemHealthMap';

/**
 * Infrastructure.
 *
 * This page used to render exactly what the dashboard rendered, which made one
 * of the two redundant. It is now the detailed view: the dashboard shows the
 * last half hour at a glance, and this is where you come to widen the window
 * and look at the service catalogue itself.
 */

const WINDOWS: { label: string; minutes: number }[] = [
  { label: '30m', minutes: DEFAULT_WINDOW_MINUTES },
  { label: '3h', minutes: 180 },
  { label: '12h', minutes: 720 },
  { label: '24h', minutes: 1440 },
];

export default function Infrastructure() {
  const [windowMinutes, setWindowMinutes] = React.useState(DEFAULT_WINDOW_MINUTES);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-white">Infrastructure</h1>

        <div
          className="flex items-center gap-1 rounded-lg border border-border bg-surface/50 p-1"
          role="group"
          aria-label="Telemetry window"
        >
          {WINDOWS.map((option) => (
            <button
              key={option.minutes}
              onClick={() => setWindowMinutes(option.minutes)}
              aria-pressed={windowMinutes === option.minutes}
              className={cn(
                'px-2.5 py-1 text-xs rounded-md transition-colors',
                windowMinutes === option.minutes
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:text-white',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-6">
        {/* The server buckets whatever range it is given, so a wider window
            costs the same number of points, not a proportionally larger one. */}
        <InfraChart windowMinutes={windowMinutes} />
        <SystemHealthMap />
      </div>
    </div>
  );
}
