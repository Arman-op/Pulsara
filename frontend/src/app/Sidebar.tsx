import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  GitMerge,
  Server,
  BellRing,
  Settings,
  Command,
  LogOut,
} from 'lucide-react';
import { cn } from '../shared/utils/cn';
import { useAuthStore } from '../shared/store/authStore';
import { fetchWithAuth } from '../shared/utils/fetchWithAuth';
import { getFirebaseAuth } from '../shared/utils/firebase';
import { signOut } from 'firebase/auth';
import { isGoogleSignInEnabled } from '../config/env';

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Pipelines', href: '/pipelines', icon: GitMerge },
  { name: 'Infrastructure', href: '/infrastructure', icon: Server },
  { name: 'Alerts', href: '/alerts', icon: BellRing },
  { name: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    try {
      // Only the federated session needs an explicit provider sign-out; a
      // password session has nothing held in the Firebase SDK.
      if (isGoogleSignInEnabled) {
        await signOut(getFirebaseAuth());
      }
      await fetchWithAuth('/auth/logout', { method: 'POST' }).catch(() => {});
      logout();
      navigate('/login');
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

  return (
    <div className="hidden md:flex flex-col w-16 lg:w-60 border-r border-border bg-surface/50 backdrop-blur-md transition-all duration-300 z-10">
      <div className="h-16 flex items-center justify-center lg:justify-start lg:px-4 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Command className="h-6 w-6 text-accent" />
          <span className="hidden lg:block font-bold text-white text-lg tracking-wider">
            Pulsara
          </span>
        </div>
      </div>

      <nav className="flex-1 p-2 flex flex-col gap-1">
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.name}
              to={item.href}
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
      </nav>

      <div className="p-4 border-t border-border/50 flex flex-col gap-2">
        {/* Desktop Profile Info & Logout */}
        <div className="hidden lg:flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt="Avatar"
                className="h-8 w-8 rounded-full shrink-0 object-cover"
              />
            ) : (
              <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-accent to-danger shrink-0" />
            )}
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium text-white truncate">
                {user?.name || 'User'}
              </span>
              <span className="text-xs text-muted truncate">{user?.email || ''}</span>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="p-1.5 text-muted hover:text-white hover:bg-card rounded-md transition-colors"
            title="Logout"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>

        {/* Mobile logout (icon only) */}
        <div className="lg:hidden flex justify-center">
          <button
            onClick={handleLogout}
            className="p-2 text-muted hover:text-white hover:bg-card rounded-md transition-colors"
            title="Logout"
          >
            <LogOut className="h-5 w-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
