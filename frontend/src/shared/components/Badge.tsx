import * as React from 'react';
import { cn } from '../utils/cn';

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'accent' | 'outline';
}

export const Badge = ({ className, variant = 'default', ...props }: BadgeProps) => {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none',
        {
          'bg-accent/20 text-accent': variant === 'accent',
          'bg-success/20 text-success': variant === 'success',
          'bg-warning/20 text-warning': variant === 'warning',
          'bg-danger/20 text-danger': variant === 'danger',
          'bg-surface border border-border text-white': variant === 'outline',
          'bg-white text-black': variant === 'default',
        },
        className,
      )}
      {...props}
    />
  );
};
