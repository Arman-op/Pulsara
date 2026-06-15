import * as React from 'react';
import { cn } from '../utils/cn';

interface StatusDotProps {
  status: 'online' | 'warning' | 'offline';
  className?: string;
}

export function StatusDot({ status, className }: StatusDotProps) {
  return (
    <span className={cn('relative flex h-2.5 w-2.5', className)}>
      <span
        className={cn('animate-ping absolute inline-flex h-full w-full rounded-full opacity-75', {
          'bg-success': status === 'online',
          'bg-warning': status === 'warning',
          'bg-danger': status === 'offline',
        })}
      />
      <span
        className={cn('relative inline-flex rounded-full h-2.5 w-2.5', {
          'bg-success': status === 'online',
          'bg-warning': status === 'warning',
          'bg-danger': status === 'offline',
        })}
      />
    </span>
  );
}
