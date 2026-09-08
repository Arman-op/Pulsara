import { signOut as firebaseSignOut } from 'firebase/auth';
import {
  BellRing,
  Command,
  GitMerge,
  LayoutDashboard,
  LogOut,
  Server,
  Settings,
  Users,
} from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { isGoogleSignInEnabled } from '../config/env';
import { signOut } from '../shared/api/client';
import type { Role } from '../shared/api/types';
import { useAuthStore } from '../shared/store/authStore';
import { cn } from '../shared/utils/cn';
import { getFirebaseAuth } from '../shared/utils/firebase';

/** `requiredRole` hides links a user's role cannot open. */
const NAVIGATION: {
  name: string;
  href: string;
  icon: typeof LayoutDashboard;
  requiredRole?: Role;
}[] = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Pipelines', href: '/pipelines', icon: GitMerge },
  { name: 'Infrastructure', href: '/infrastructure', icon: Server },
  { name: 'Alerts', href: '/alerts', icon: BellRing },
  { name: 'Users', href: '/users', icon: Users, requiredRole: 'ADMIN' },
  { name: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const user = useAuthStore((store) => store.user);
  const navigate = useNavigate();

  const handleSignOut = async () => {
    /**
     * The Firebase session is only signed out when the provider is actually
     * configured. Calling into the SDK otherwise throws, and the previous
     * version let that throw abort the whole handler — so a failure to sign out
     * of Google also prevented signing out of Pulsara.
     */
    if (isGoogleSignInEnabled) {
      await firebaseSignOut(getFirebaseAuth()).catch(() => undefined);
    }

    await signOut();
    navigate('/login', { replace: true });
  };

  const visible = NAVIGATION.filter(
    (item) => !item.requiredRole || item.requiredRole === user?.role,
  );

  return (
    <nav
      aria-label="Primary"
      className="hidden md:flex flex-col w-16 lg:w-60 border-r border-border bg-surface/50 backdrop-blur-md transition-all duration-300 z-10"
    >
      <div className="h-16 flex items-center justify-center lg:justify-start lg:px-4 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Command className="h-6 w-6 text-accent" />
          <span className="hidden lg:block font-bold text-white text-lg tracking-wider">
            Pulsara
          </span>
        </div>
      </div>

      <div className="flex-1 p-2 flex flex-col gap-1">
        {visible.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.name}
              to={item.href}
              // `end` keeps the dashboard link from matching every child route.
              end={item.href === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center justify-center lg:justify-start gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-200',
                  isActive
                    ? 'bg-accent/10 text-accent'
                    : 'text-muted hover:bg-surface hover:text-white',
                )
              }
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="hidden lg:block">{item.name}</span>
            </NavLink>
          );
        })}
      </div>

      <div className="p-4 border-t border-border/50">
        <div className="hidden lg:flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt=""
                className="h-8 w-8 rounded-full shrink-0 object-cover"
              />
            ) : (
              <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-accent to-danger shrink-0" />
            )}
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium text-white truncate">{user?.name}</span>
              <span className="text-xs text-muted truncate">{user?.role}</span>
            </div>
          </div>
          <button
            onClick={() => void handleSignOut()}
            className="p-1.5 text-muted hover:text-white hover:bg-card rounded-md transition-colors"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>

        <div className="lg:hidden flex justify-center">
          <button
            onClick={() => void handleSignOut()}
            className="p-2 text-muted hover:text-white hover:bg-card rounded-md transition-colors"
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </div>
    </nav>
  );
}
