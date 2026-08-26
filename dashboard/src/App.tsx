import * as React from 'react';
import {
  AlertTriangle,
  BarChart3,
  Clock,
  Grid3x3,
  PhoneCall,
  RefreshCw,
  MessagesSquare,
  ShoppingBag,
  Shirt,
  TrendingDown,
  Wallet,
} from 'lucide-react';
import { Tabs, TabsContent, TabsNavItem } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { fetchDashboard, NotSignedIn, type DashboardData } from '@/lib/api';
import { ActionQueue } from '@/tabs/ActionQueue';
import { Acquisition } from '@/tabs/Acquisition';
import { Carts } from '@/tabs/Carts';
import { Conversations } from '@/tabs/Conversations';
import { Demand } from '@/tabs/Demand';
import { Dropoff } from '@/tabs/Dropoff';
import { Products } from '@/tabs/Products';
import { Revenue } from '@/tabs/Revenue';
import { Risk } from '@/tabs/Risk';
import { Timing } from '@/tabs/Timing';

const WINDOWS = [7, 30, 90, 365];

/**
 * The rail, in order.
 *
 * Grouped by what somebody came here to do: act on something, check nothing is
 * on fire, then read the numbers. Action Queue leads because it is the only
 * tab that is a to-do list.
 */
const SECTIONS = [
  { value: 'action', label: 'Action Queue', icon: <PhoneCall size={16} />, group: 'Today' },
  { value: 'risk', label: 'Risk & Delivery', icon: <AlertTriangle size={16} />, group: 'Today' },
  { value: 'acquisition', label: 'Acquisition', icon: <BarChart3 size={16} />, group: 'Performance' },
  { value: 'dropoff', label: 'Drop-off', icon: <TrendingDown size={16} />, group: 'Performance' },
  { value: 'revenue', label: 'Revenue', icon: <Wallet size={16} />, group: 'Performance' },
  { value: 'products', label: 'Products', icon: <Shirt size={16} />, group: 'Catalogue' },
  { value: 'demand', label: 'Demand', icon: <Grid3x3 size={16} />, group: 'Catalogue' },
  { value: 'carts', label: 'Carts', icon: <ShoppingBag size={16} />, group: 'Catalogue' },
  { value: 'timing', label: 'Timing', icon: <Clock size={16} />, group: 'Catalogue' },
  {
    value: 'conversations',
    label: 'Conversations',
    icon: <MessagesSquare size={16} />,
    group: 'Catalogue',
  },
] as const;

const GROUPS = ['Today', 'Performance', 'Catalogue'] as const;

/**
 * What went wrong, in words rather than a query string.
 *
 * `pending` is the one that matters: it is not a failure, it is the system
 * working. Somebody signed in with a real Google account and is waiting to be
 * let in, and telling them "access denied" would send them to support instead
 * of to whoever approves accounts.
 */
const SIGN_IN_PROBLEMS: Record<string, string> = {
  pending: 'Your account is waiting for approval. Ask an admin to enable it.',
  blocked: 'This account has been blocked.',
  unverified: 'That Google account has not verified its email address.',
  cancelled: 'Sign-in was cancelled.',
  expired: 'That sign-in link expired. Try again.',
  incomplete: 'Google did not send back everything needed. Try again.',
  'google-failed': 'Google could not confirm the sign-in. Try again.',
};

export default function App() {
  const [days, setDays] = React.useState(30);
  const [phone, setPhone] = React.useState('');
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [signIn, setSignIn] = React.useState<NotSignedIn | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    fetchDashboard(days, phone)
      .then((d) => {
        setData(d);
        setError(null);
        setSignIn(null);
      })
      .catch((e: Error) => {
        if (e instanceof NotSignedIn) setSignIn(e);
        else setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [days, phone]);

  React.useEffect(load, [load]);

  /*
   * The sign-in screen. Deliberately the whole page and nothing else: there is
   * no data to show behind it, and a dashboard that renders empty tiles under a
   * modal invites somebody to wonder whether the numbers are real zeroes.
   */
  if (signIn) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-6">
        <span className="grid h-10 w-10 place-items-center rounded bg-accent text-base font-bold text-white">
          R
        </span>
        <h1 className="mt-5 text-lg font-semibold">Stylist Control Room</h1>
        <p className="mt-2 text-sm text-subtle">{signIn.message}</p>

        {signIn.reason ? (
          <p className="mt-4 rounded border border-border bg-card p-3 text-sm">
            {SIGN_IN_PROBLEMS[signIn.reason] ?? 'Sign-in did not complete. Try again.'}
          </p>
        ) : null}

        {signIn.signInUrl ? (
          <Button className="mt-6 self-start" onClick={() => (window.location.href = signIn.signInUrl!)}>
            Continue with Google
          </Button>
        ) : (
          <p className="mt-6 text-sm text-subtle">
            Google sign-in is not configured on this server.
          </p>
        )}
      </main>
    );
  }

  if (error) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center p-6">
        <h1 className="text-lg font-semibold">The dashboard could not load</h1>
        <p className="mt-2 text-sm text-subtle">{error}</p>
        <Button className="mt-6 self-start" onClick={load}>
          Try again
        </Button>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-subtle">
        Loading…
      </main>
    );
  }

  const a = data.analytics;
  const overdue = data.callbacks.filter((c) => c.overdue).length;
  const badges: Record<string, number> = {
    action: overdue,
    risk: a.risk.declined ? 1 : 0,
    carts: a.abandonedCarts.length,
  };

  return (
    <Tabs defaultValue="action">
      <div className="flex min-h-screen">
        {/*
          The rail is fixed to the viewport and scrolls on its own. The report
          beside it can be as long as it likes without ever moving the nav —
          and because only one panel is mounted, scrolling cannot change which
          tab is selected.
        */}
        <aside className="sticky top-0 hidden h-screen w-[252px] shrink-0 flex-col bg-sidebar lg:flex">
          {/* Brand block — Gentelella's site_title, with a hairline under it. */}
          <div className="flex items-center gap-2.5 border-b border-sidebar-border px-5 py-4">
            <span className="grid h-8 w-8 place-items-center rounded bg-accent text-sm font-bold text-white">
              R
            </span>
            <span className="font-semibold tracking-tight text-sidebar-text-active">
              Reistor Stylist
            </span>
          </div>

          {/* Profile block. Shows what this report covers rather than a user. */}
          <div className="border-b border-sidebar-border px-5 py-4">
            <div className="text-[11px] uppercase tracking-wider text-sidebar-text">Reporting on</div>
            <div className="mt-1 text-sm text-sidebar-text-hover">
              {data.range.phoneNumberId ? `…${data.range.phoneNumberId.slice(-6)}` : 'All numbers'}
            </div>
            <div className="tabular mt-0.5 text-[11px] text-sidebar-text">
              {data.range.from} – {data.range.to}
            </div>
          </div>

          <nav className="flex-1 space-y-4 overflow-y-auto py-3">
            {GROUPS.map((group) => (
              <div key={group}>
                <div className="px-5 pb-1.5 text-[10px] uppercase tracking-widest text-sidebar-text">
                  {group}
                </div>
                <div>
                  {SECTIONS.filter((s) => s.group === group).map((s) => (
                    <TabsNavItem
                      key={s.value}
                      value={s.value}
                      icon={s.icon}
                      badge={badges[s.value]}
                    >
                      {s.label}
                    </TabsNavItem>
                  ))}
                </div>
              </div>
            ))}
          </nav>

          <div className="border-t border-sidebar-border px-5 py-4 text-[11px] leading-relaxed text-sidebar-text">
            Generated {new Date(data.generatedAt).toLocaleTimeString('en-IN')}
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-10 border-b border-border bg-body/85 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
              <div>
                <h1 className="text-lg font-semibold tracking-tight">Stylist Control Room</h1>
                <p className="text-xs text-subtle">Reistor AI Stylist on WhatsApp</p>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="h-9 rounded border border-border bg-card px-3 text-sm"
                >
                  {WINDOWS.map((d) => (
                    <option key={d} value={d}>
                      Last {d} days
                    </option>
                  ))}
                </select>
                <select
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="h-9 rounded border border-border bg-card px-3 text-sm"
                >
                  <option value="">Live number</option>
                  <option value="all">All numbers</option>
                </select>
                <Button variant="secondary" onClick={load} disabled={loading}>
                  <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
                </Button>
              </div>
            </div>

            {/* The rail collapses below lg; this strip replaces it. */}
            <nav className="flex gap-1 overflow-x-auto px-4 pb-3 lg:hidden">
              {SECTIONS.map((s) => (
                <div key={s.value} className="w-auto shrink-0">
                  <TabsNavItem value={s.value} icon={s.icon} badge={badges[s.value]}>
                    {s.label}
                  </TabsNavItem>
                </div>
              ))}
            </nav>
          </header>

          <div className="px-6 py-5">
            {a.errors.length > 0 && (
              <div className="mb-6 rounded-lg border border-warn bg-warn-lt p-4 text-sm">
                <b className="text-warn">Some numbers are unavailable.</b> These queries failed, so
                the tabs below are incomplete rather than empty:
                <ul className="mt-2 list-inside list-disc text-xs text-subtle">
                  {a.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            <TabsContent value="action">
              <ActionQueue callbacks={data.callbacks} onChange={load} />
            </TabsContent>
            <TabsContent value="risk">
              <Risk risk={a.risk} health={data.health} attrition={data.attrition} />
            </TabsContent>
            <TabsContent value="acquisition">
              <Acquisition rows={a.acquisition} />
            </TabsContent>
            <TabsContent value="dropoff">
              <Dropoff funnel={data.funnel} attrition={data.attrition} />
            </TabsContent>
            <TabsContent value="revenue">
              <Revenue
                revenue={data.revenue}
                timing={a.timing}
                callbackOutcome={a.callbackOutcome}
                cost={data.cost}
              />
            </TabsContent>
            <TabsContent value="products">
              <Products
                topProducts={data.topProducts}
                conversion={data.productConversion}
                stockGaps={a.stockGaps}
                lostDemand={data.lostDemand}
              />
            </TabsContent>
            <TabsContent value="demand">
              <Demand grid={data.demandGrid} searchMisses={a.searchMisses} />
            </TabsContent>
            <TabsContent value="carts">
              <Carts carts={a.abandonedCarts} />
            </TabsContent>
            <TabsContent value="timing">
              <Timing cells={a.hourHeatmap} />
            </TabsContent>
            <TabsContent value="conversations">
              <Conversations chats={a.conversations} />
            </TabsContent>
          </div>

          <footer className="border-t border-border px-6 py-4 text-xs text-subtle">
            Reistor AI Stylist · figures cover the selected window only, and every panel states
            what its number does not mean.
          </footer>
        </div>
      </div>
    </Tabs>
  );
}
