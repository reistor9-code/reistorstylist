/**
 * Who can open this dashboard.
 *
 * Approving somebody here hands them every customer's phone number and every
 * conversation, so the pending list leads and the count is on the rail. The
 * alternative was a SQL statement in Supabase, which works for one person and
 * ends with somebody sharing a login.
 */

import * as React from 'react';
import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchTeam, updateMember, type TeamMember } from '@/lib/api';

const STATUS_TONE: Record<TeamMember['status'], 'good' | 'warn' | 'bad'> = {
  active: 'good',
  pending: 'warn',
  blocked: 'bad',
};

function when(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function Team({ me }: { me: string }) {
  const [users, setUsers] = React.useState<TeamMember[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    fetchTeam()
      .then((u) => {
        setUsers(u);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  React.useEffect(load, [load]);

  async function change(email: string, patch: Parameters<typeof updateMember>[1]) {
    setBusy(email);
    try {
      await updateMember(email, patch);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="text-sm text-bad">{error}</p>;
  if (!users) return <p className="text-sm text-subtle">Loading…</p>;

  const waiting = users.filter((u) => u.status === 'pending');
  const rest = users.filter((u) => u.status !== 'pending');

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Waiting for approval</CardTitle>
          <Badge variant={waiting.length ? 'warn' : 'good'}>{waiting.length} waiting</Badge>
        </CardHeader>
        <CardContent>
          {waiting.length === 0 ? (
            <p className="text-sm text-subtle">Nobody is waiting.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {waiting.map((u) => (
                <li
                  key={u.email}
                  className="flex flex-wrap items-center justify-between gap-3 rounded border border-border p-3"
                >
                  <div>
                    <div className="text-sm font-medium">{u.name ?? u.email}</div>
                    <div className="text-xs text-subtle">
                      {u.email} · asked {when(u.created_at)}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy === u.email}
                      onClick={() => change(u.email, { status: 'active' })}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy === u.email}
                      onClick={() => change(u.email, { status: 'blocked' })}
                    >
                      Block
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <CardNote>
            Approving an account gives it the whole dashboard. Only approve people you know.
          </CardNote>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <Badge>{rest.length}</Badge>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-subtle">
                  <th className="py-2 pr-3">Person</th>
                  <th className="py-2 pr-3">Role</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Last seen</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rest.map((u) => {
                  const self = u.email === me;
                  return (
                    <tr key={u.email} className="border-t border-border">
                      <td className="py-2 pr-3">
                        <div className="font-medium">
                          {u.name ?? u.email}
                          {self ? <span className="ml-2 text-xs text-subtle">you</span> : null}
                        </div>
                        <div className="text-xs text-subtle">{u.email}</div>
                      </td>
                      <td className="py-2 pr-3">{u.role}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={STATUS_TONE[u.status]}>{u.status}</Badge>
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{when(u.last_login_at)}</td>
                      <td className="py-2">
                        {/*
                          Nothing to press on your own row. The server refuses it
                          too — an admin who blocks themselves is a support call,
                          not a security feature — but a disabled button explains
                          that better than an error does.
                        */}
                        {self ? null : (
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="ghost"
                              disabled={busy === u.email}
                              onClick={() =>
                                change(u.email, {
                                  role: u.role === 'admin' ? 'viewer' : 'admin',
                                })
                              }
                            >
                              Make {u.role === 'admin' ? 'viewer' : 'admin'}
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={busy === u.email}
                              onClick={() =>
                                change(u.email, {
                                  status: u.status === 'blocked' ? 'active' : 'blocked',
                                })
                              }
                            >
                              {u.status === 'blocked' ? 'Unblock' : 'Block'}
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <CardNote>
            A viewer sees the aggregate numbers. An admin also sees phone numbers, transcripts and
            this page.
          </CardNote>
        </CardContent>
      </Card>
    </div>
  );
}
