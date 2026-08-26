/**
 * The way in.
 *
 * Two doors to the same room. Google is the one to prefer — nothing to store,
 * nothing to leak, nothing to reset — and it leads. Email and password sits
 * under it for the people who expect a sign-in page to have one.
 *
 * Signing up does not let anybody in. It records a request, and the screen
 * says so plainly rather than dropping somebody on an empty dashboard or a
 * bare "access denied" that reads like a fault.
 */

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { signIn, signUp } from '@/lib/api';

type Mode = 'in' | 'up';

/** Reasons Google can bounce somebody back, in words rather than a code. */
const PROBLEMS: Record<string, string> = {
  pending: 'Your account is waiting for approval. Ask an admin to enable it.',
  blocked: 'This account has been blocked.',
  unverified: 'That Google account has not verified its email address.',
  cancelled: 'Sign-in was cancelled.',
  expired: 'That sign-in link expired. Try again.',
  incomplete: 'Google did not send back everything needed. Try again.',
  'google-failed': 'Google could not confirm the sign-in. Try again.',
};

export function SignIn({
  message,
  googleUrl,
  reason,
}: {
  message: string;
  googleUrl: string | null;
  reason: string | null;
}) {
  const [mode, setMode] = React.useState<Mode>('in');
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'up') {
        const res = await signUp(name, email, password);
        // Active only when the address was already named on the server.
        if (res.status === 'active') window.location.reload();
        else setPending(true);
      } else {
        await signIn(email, password);
        window.location.reload();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <Shell>
        <h1 className="mt-5 text-lg font-semibold">Request sent</h1>
        <p className="mt-2 text-sm text-subtle">
          Your account has been created and is waiting for approval. An admin has to enable it
          before you can sign in.
        </p>
        <Button className="mt-6 self-start" onClick={() => window.location.reload()}>
          Back to sign in
        </Button>
      </Shell>
    );
  }

  const field = 'mt-1 w-full rounded border border-border bg-card px-3 py-2 text-sm outline-none focus:border-accent';

  return (
    <Shell>
      <h1 className="mt-5 text-lg font-semibold">Stylist Control Room</h1>
      <p className="mt-1 text-sm text-subtle">
        {mode === 'in' ? message : 'Create an account to request access.'}
      </p>

      {reason ? (
        <p className="mt-4 rounded border border-border bg-card p-3 text-sm">
          {PROBLEMS[reason] ?? 'Sign-in did not complete. Try again.'}
        </p>
      ) : null}

      {googleUrl ? (
        <>
          <Button
            className="mt-6 w-full justify-center"
            onClick={() => (window.location.href = googleUrl)}
          >
            Continue with Google
          </Button>
          <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-subtle">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      ) : null}

      <form onSubmit={submit} className="flex flex-col gap-3 text-left">
        {mode === 'up' ? (
          <label className="text-sm">
            Name
            <input
              className={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          </label>
        ) : null}

        <label className="text-sm">
          Email
          <input
            className={field}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>

        <label className="text-sm">
          Password
          <input
            className={field}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            /* Tells a password manager to offer a new one rather than autofill an old. */
            autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
            required
          />
          {mode === 'up' ? (
            <span className="mt-1 block text-xs text-subtle">At least 12 characters.</span>
          ) : null}
        </label>

        {error ? <p className="text-sm text-bad">{error}</p> : null}

        <Button type="submit" disabled={busy} className="mt-1 w-full justify-center">
          {busy ? 'Working…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </Button>
      </form>

      <button
        type="button"
        className="mt-5 text-sm text-subtle underline underline-offset-4"
        onClick={() => {
          setMode(mode === 'in' ? 'up' : 'in');
          setError(null);
        }}
      >
        {mode === 'in' ? 'Create an account' : 'I already have an account'}
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-6">
      <span className="grid h-10 w-10 place-items-center rounded bg-accent text-base font-bold text-white">
        R
      </span>
      {children}
    </main>
  );
}
