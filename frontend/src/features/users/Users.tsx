import * as React from 'react';
import { ApiError, apiRequest } from '../../shared/api/client';
import type { AuthUser, Role } from '../../shared/api/types';
import { useApi } from '../../shared/api/useApi';
import { Badge } from '../../shared/components/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../shared/components/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../shared/components/Table';
import { useAuthStore } from '../../shared/store/authStore';
import { useToastStore } from '../../shared/store/toastStore';

/**
 * User administration.
 *
 * Without a screen like this the role hierarchy was unreachable: the first
 * account became ADMIN and every account after it was stuck as a VIEWER with no
 * way to be promoted.
 */

type ManagedUser = AuthUser & {
  isActive: boolean;
  createdAt: string;
};

const ROLES: Role[] = ['VIEWER', 'MEMBER', 'ADMIN'];

const ROLE_DESCRIPTION: Record<Role, string> = {
  VIEWER: 'Read-only access to every view.',
  MEMBER: 'Can manage incidents.',
  ADMIN: 'Full access, including users and integrations.',
};

export default function Users() {
  const currentUser = useAuthStore((store) => store.user);
  const addToast = useToastStore((store) => store.addToast);
  const { data, isLoading, error, refresh } = useApi<ManagedUser[]>('/users');
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  const mutate = async (user: ManagedUser, body: Record<string, unknown>, success: string) => {
    setPendingId(user.id);
    try {
      await apiRequest(`/users/${user.id}`, { method: 'PATCH', body });
      addToast({ type: 'success', title: success });
      refresh();
    } catch (caught) {
      addToast({
        type: 'error',
        title: 'Change rejected',
        message: caught instanceof ApiError ? caught.message : 'Something went wrong',
      });
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Users</h1>
        <p className="text-sm text-muted mt-1">
          New accounts start as VIEWER and must be promoted deliberately.
        </p>
      </div>

      <Card className="border-border/50 bg-surface/30 backdrop-blur-xl">
        <CardHeader>
          <CardTitle>Team</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <p className="p-8 text-center text-sm text-muted">Loading users…</p>
          ) : error ? (
            <p className="p-8 text-center text-sm text-danger" role="alert">
              {error}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data ?? []).map((user) => {
                  const isSelf = user.id === currentUser?.id;
                  const isBusy = pendingId === user.id;

                  return (
                    <TableRow key={user.id} className={user.isActive ? '' : 'opacity-50'}>
                      <TableCell className="font-medium text-white">
                        {user.name}
                        {isSelf && <span className="ml-2 text-xs text-muted">(you)</span>}
                      </TableCell>
                      <TableCell className="text-muted">{user.email}</TableCell>
                      <TableCell className="text-muted text-xs">
                        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'never'}
                      </TableCell>
                      <TableCell>
                        <select
                          value={user.role}
                          /* An administrator cannot demote themselves; the server
                             enforces it too, but disabling the control explains
                             why instead of producing a rejected request. */
                          disabled={isSelf || isBusy || !user.isActive}
                          onChange={(event) =>
                            void mutate(
                              user,
                              { role: event.target.value },
                              `${user.name} is now ${event.target.value}`,
                            )
                          }
                          title={
                            isSelf ? 'You cannot change your own role' : ROLE_DESCRIPTION[user.role]
                          }
                          className="bg-surface border border-border rounded-md px-2 py-1 text-sm text-white disabled:opacity-50 disabled:cursor-not-allowed focus:ring-2 focus:ring-accent outline-none"
                        >
                          {ROLES.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </select>
                      </TableCell>
                      <TableCell className="text-right">
                        {isSelf ? (
                          <Badge variant="success">Active</Badge>
                        ) : (
                          <button
                            disabled={isBusy}
                            onClick={() =>
                              void mutate(
                                user,
                                { isActive: !user.isActive },
                                user.isActive
                                  ? `${user.name} deactivated and signed out`
                                  : `${user.name} reactivated`,
                              )
                            }
                            className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-surface transition-colors disabled:opacity-50"
                          >
                            {user.isActive ? 'Deactivate' : 'Reactivate'}
                          </button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
