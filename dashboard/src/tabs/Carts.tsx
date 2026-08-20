import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Empty, Stat } from '@/components/ui/stat';
import { num } from '@/lib/utils';
import type { AnalyticsData } from '@/lib/api';

/**
 * Carts sent and never paid.
 *
 * The strongest intent signal in the whole flow — they picked the garment,
 * chose to send it, and stopped. `windowOpen` is on every row because it is
 * the difference between a free reply and a charged template, and that is a
 * decision somebody should make deliberately.
 */
export function Carts({ carts }: { carts: AnalyticsData['abandonedCarts'] }) {
  const free = carts.filter((c) => c.windowOpen && !c.marketingOptOut);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Carts abandoned" value={num(carts.length)} />
        <Stat
          label="Reachable free"
          value={num(free.length)}
          tone={free.length ? 'good' : 'default'}
          hint="inside the 24h window"
        />
        <Stat
          label="Would cost a template"
          value={num(carts.length - free.length)}
          tone={carts.length - free.length ? 'warn' : 'default'}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sent but not paid</CardTitle>
          <Badge variant={carts.length ? 'warn' : 'default'}>{carts.length}</Badge>
        </CardHeader>
        <CardContent>
          {carts.length === 0 ? (
            <Empty>
              No abandoned carts. A cart lands here once a shopper sends it and no payment follows.
            </Empty>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {carts.map((c) => (
                <li key={c.sessionId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <span className="min-w-0">
                    <span className="tabular font-medium">
                      +{c.waId.replace(/\D/g, '')}
                    </span>
                    <span className="ml-2 text-subtle">
                      {c.profileName || 'No profile name'}
                      {c.sizePicked ? ` · size ${c.sizePicked}` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular text-xs text-subtle">
                      {Math.round(c.hoursSince)}h ago
                    </span>
                    {c.marketingOptOut ? (
                      <Badge variant="bad">opted out</Badge>
                    ) : c.windowOpen ? (
                      <Badge variant="good">free to reply</Badge>
                    ) : (
                      <Badge variant="warn">needs a template</Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <CardNote>
            One recovery message, never two. Inside the 24-hour window a reply is free and
            unrestricted; outside it every nudge is a Marketing template that needs opt-in — and
            that is exactly the message people block, which costs the quality rating.
          </CardNote>
        </CardContent>
      </Card>
    </>
  );
}
