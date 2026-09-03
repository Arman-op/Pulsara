import { Github, Link as LinkIcon, Monitor, Shield, Trash2, User } from 'lucide-react';
import * as React from 'react';
import { ApiError, apiRequest, signOut } from '../../shared/api/client';
import type { AuthUser, RepoConnection } from '../../shared/api/types';
import { useApi } from '../../shared/api/useApi';
import { Button } from '../../shared/components/Button';
import { Card, CardContent, CardHeader, CardTitle } from '../../shared/components/Card';
import { Input } from '../../shared/components/Input';
import { useAuthStore } from '../../shared/store/authStore';
import { useToastStore } from '../../shared/store/toastStore';

/**
 * Settings.
 *
 * Every control on this screen used to be inert markup. "Save Changes" had no
 * handler, the password form submitted nowhere, the notification checkboxes
 * stored nothing, and the integrations panel showed GitHub as "Connected to
 * repository parsing" and Slack as "Not connected" — both hard-coded strings
 * describing integrations that did not exist.
 *
 * What is here now is backed by real endpoints. The notifications tab is gone
 * rather than reimplemented: nothing in this system sends a notification, so a
 * panel of preferences would be a promise the product cannot keep. It comes
 * back with a notifier behind it.
 */

type Session = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
};

type ConnectionMeta = { pollingConfigured: boolean; webhookConfigured: boolean };

const TABS = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'sessions', label: 'Sessions', icon: Monitor },
  { id: 'integrations', label: 'Integrations', icon: LinkIcon },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** Mirrors the server's minimum; enforcing it here avoids a pointless round trip. */
const MIN_PASSWORD_LENGTH = 12;

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : 'Something went wrong';
}

function ProfilePanel() {
  const user = useAuthStore((store) => store.user);
  const updateUser = useAuthStore((store) => store.updateUser);
  const addToast = useToastStore((store) => store.addToast);

  const [name, setName] = React.useState(user?.name ?? '');
  const [isSaving, setIsSaving] = React.useState(false);

  const isDirty = name.trim() !== (user?.name ?? '') && name.trim().length > 0;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      const updated = await apiRequest<AuthUser>('/auth/me', {
        method: 'PATCH',
        body: { name: name.trim() },
      });
      updateUser(updated);
      addToast({ type: 'success', title: 'Profile updated' });
    } catch (error) {
      addToast({ type: 'error', title: 'Could not save', message: describeError(error) });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className="border-border/50 bg-surface/30 backdrop-blur-xl">
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <p className="text-sm text-muted mt-1">How you appear to your team.</p>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4 max-w-md">
          <div className="space-y-2">
            <label className="text-sm font-medium text-white" htmlFor="profile-name">
              Full name
            </label>
            <Input
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-white" htmlFor="profile-email">
              Email address
            </label>
            <Input id="profile-email" value={user?.email ?? ''} disabled />
            {/* Stating why beats a field that looks editable and silently is not. */}
            <p className="text-xs text-muted">
              Your email identifies your account to the identity provider and cannot be changed
              here.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-white" htmlFor="profile-role">
              Role
            </label>
            <Input id="profile-role" value={user?.role ?? ''} disabled />
            <p className="text-xs text-muted">Only an administrator can change a role.</p>
          </div>

          <Button type="submit" isLoading={isSaving} disabled={!isDirty}>
            Save changes
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SecurityPanel() {
  const addToast = useToastStore((store) => store.addToast);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);

  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const canSubmit =
    currentPassword.length > 0 && newPassword.length >= MIN_PASSWORD_LENGTH && !mismatch;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      await apiRequest('/auth/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      addToast({
        type: 'success',
        title: 'Password changed',
        message: 'All sessions were signed out. Please sign in again.',
      });
      /**
       * The server revokes every session on a password change, including this
       * one, so the local state must be cleared too. Leaving the user on a
       * dashboard backed by a dead token would show them a screen that fails on
       * its next request.
       */
      await signOut();
    } catch (error) {
      addToast({
        type: 'error',
        title: 'Could not change password',
        message: describeError(error),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className="border-border/50 bg-surface/30 backdrop-blur-xl">
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <p className="text-sm text-muted mt-1">
          Changing your password signs you out of every device, including this one.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4 max-w-sm">
          <div className="space-y-2">
            <label className="text-sm font-medium text-white" htmlFor="current-password">
              Current password
            </label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-white" htmlFor="new-password">
              New password
            </label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
            <p className={`text-xs ${tooShort ? 'text-danger' : 'text-muted'}`}>
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-white" htmlFor="confirm-password">
              Confirm new password
            </label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
            {mismatch && <p className="text-xs text-danger">Passwords do not match.</p>}
          </div>

          <Button type="submit" variant="danger" isLoading={isSaving} disabled={!canSubmit}>
            Update password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SessionsPanel() {
  const addToast = useToastStore((store) => store.addToast);
  const { data, isLoading, error, refresh } = useApi<Session[]>('/auth/sessions');
  const [isRevoking, setIsRevoking] = React.useState(false);

  const revokeAll = async () => {
    setIsRevoking(true);
    try {
      await apiRequest('/auth/sessions', { method: 'DELETE' });
      addToast({ type: 'success', title: 'Signed out everywhere' });
      await signOut();
    } catch (caught) {
      addToast({ type: 'error', title: 'Could not revoke', message: describeError(caught) });
      setIsRevoking(false);
      refresh();
    }
  };

  return (
    <Card className="border-border/50 bg-surface/30 backdrop-blur-xl">
      <CardHeader>
        <CardTitle>Active sessions</CardTitle>
        <p className="text-sm text-muted mt-1">
          Every device currently signed in to your account. A session you do not recognise is worth
          acting on.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted">Loading sessions…</p>
        ) : error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : (
          <ul className="space-y-2">
            {(data ?? []).map((session) => (
              <li
                key={session.id}
                className="flex items-start justify-between gap-4 p-3 rounded-lg bg-surface border border-border"
              >
                <div className="min-w-0">
                  <p className="text-sm text-white truncate" title={session.userAgent ?? ''}>
                    {session.userAgent ?? 'Unknown device'}
                  </p>
                  <p className="text-xs text-muted mt-0.5">
                    {session.ipAddress ?? 'unknown address'} · started{' '}
                    {new Date(session.createdAt).toLocaleString()}
                  </p>
                </div>
                <span className="text-xs text-muted shrink-0">
                  expires {new Date(session.expiresAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}

        <Button variant="danger" onClick={revokeAll} isLoading={isRevoking}>
          Sign out everywhere
        </Button>
      </CardContent>
    </Card>
  );
}

function IntegrationsPanel() {
  const user = useAuthStore((store) => store.user);
  const addToast = useToastStore((store) => store.addToast);
  const { data, meta, isLoading, error, refresh } = useApi<RepoConnection[], ConnectionMeta>(
    '/integrations/github/connections',
  );

  const [owner, setOwner] = React.useState('');
  const [name, setName] = React.useState('');
  const [isConnecting, setIsConnecting] = React.useState(false);

  const isAdmin = user?.role === 'ADMIN';

  const connect = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsConnecting(true);
    try {
      await apiRequest('/integrations/github/connections', {
        method: 'POST',
        body: { owner: owner.trim(), name: name.trim() },
      });
      addToast({ type: 'success', title: `Connected ${owner}/${name}` });
      setOwner('');
      setName('');
      refresh();
    } catch (caught) {
      addToast({ type: 'error', title: 'Could not connect', message: describeError(caught) });
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnect = async (connection: RepoConnection) => {
    try {
      await apiRequest(`/integrations/github/connections/${connection.id}`, { method: 'DELETE' });
      addToast({ type: 'success', title: 'Disconnected', message: 'Run history was kept.' });
      refresh();
    } catch (caught) {
      addToast({ type: 'error', title: 'Could not disconnect', message: describeError(caught) });
    }
  };

  return (
    <Card className="border-border/50 bg-surface/30 backdrop-blur-xl">
      <CardHeader>
        <CardTitle>GitHub Actions</CardTitle>
        <p className="text-sm text-muted mt-1">
          Repositories whose workflow runs appear in Pipelines.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* States the real capability rather than a hard-coded "Connected". */}
        {meta && (
          <div className="text-xs text-muted space-y-1 p-3 rounded-lg bg-surface border border-border">
            <p>
              API token:{' '}
              <span className={meta.pollingConfigured ? 'text-success' : 'text-warning'}>
                {meta.pollingConfigured ? 'configured' : 'not configured'}
              </span>{' '}
              — required to read run history.
            </p>
            <p>
              Webhook secret:{' '}
              <span className={meta.webhookConfigured ? 'text-success' : 'text-warning'}>
                {meta.webhookConfigured ? 'configured' : 'not configured'}
              </span>{' '}
              — enables live updates.
            </p>
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-muted">Loading connections…</p>
        ) : error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : (data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted">No repositories are connected.</p>
        ) : (
          <ul className="space-y-2">
            {(data ?? []).map((connection) => (
              <li
                key={connection.id}
                className="flex items-center justify-between gap-4 p-3 rounded-lg bg-surface border border-border"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Github className="w-5 h-5 text-muted shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">
                      {connection.owner}/{connection.name}
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      {connection._count ? `${connection._count.deployments} runs · ` : ''}
                      {connection.lastSyncedAt
                        ? `synced ${new Date(connection.lastSyncedAt).toLocaleTimeString()}`
                        : 'never synced'}
                    </p>
                    {/* A revoked token must be visible, not silently empty. */}
                    {connection.lastSyncError && (
                      <p className="text-xs text-danger mt-0.5" title={connection.lastSyncError}>
                        Sync failed: {connection.lastSyncError}
                      </p>
                    )}
                  </div>
                </div>
                {isAdmin && (
                  <button
                    onClick={() => void disconnect(connection)}
                    className="p-2 text-muted hover:text-danger transition-colors shrink-0"
                    title="Disconnect this repository"
                    aria-label={`Disconnect ${connection.owner}/${connection.name}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {isAdmin ? (
          <form onSubmit={connect} className="flex flex-wrap items-end gap-3 pt-2">
            <div className="space-y-2">
              <label className="text-xs font-medium text-white" htmlFor="repo-owner">
                Owner
              </label>
              <Input
                id="repo-owner"
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                placeholder="octocat"
                className="w-40"
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-white" htmlFor="repo-name">
                Repository
              </label>
              <Input
                id="repo-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="hello-world"
                className="w-52"
                required
              />
            </div>
            <Button type="submit" isLoading={isConnecting}>
              Connect
            </Button>
          </form>
        ) : (
          <p className="text-xs text-muted">Connecting a repository requires the ADMIN role.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const [tab, setTab] = React.useState<TabId>('profile');

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold tracking-tight text-white">Settings</h1>

      <div className="flex flex-col md:flex-row gap-8">
        <aside className="w-full md:w-56 flex-shrink-0">
          <nav className="flex flex-col space-y-1" aria-label="Settings sections">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                aria-current={tab === id ? 'page' : undefined}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  tab === id
                    ? 'bg-accent/10 text-accent'
                    : 'text-muted hover:bg-surface hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </nav>
        </aside>

        <main className="flex-1 space-y-6">
          {tab === 'profile' && <ProfilePanel />}
          {tab === 'security' && <SecurityPanel />}
          {tab === 'sessions' && <SessionsPanel />}
          {tab === 'integrations' && <IntegrationsPanel />}
        </main>
      </div>
    </div>
  );
}
