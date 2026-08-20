import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bar, Empty, Stat } from '@/components/ui/stat';
import { num, pct } from '@/lib/utils';
import type { DashboardData } from '@/lib/api';

const HOT = 50;

/** The funnel, and where the people who left it went. */
export function Dropoff({
  funnel,
  attrition,
}: {
  funnel: DashboardData['funnel'];
  attrition: DashboardData['attrition'];
}) {
  const peak = funnel.length ? funnel[0].sessions : 0;
  const worst = funnel.filter((f) => f.lostPct >= HOT)[0];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Funnel</CardTitle>
          <Badge>{num(peak)} chats</Badge>
        </CardHeader>
        <CardContent>
          {peak === 0 ? (
            <Empty>
              No chats in this window. The funnel fills the moment somebody messages the number — it
              comes from live webhooks, not the nightly job.
            </Empty>
          ) : (
            <ul className="space-y-3">
              {funnel.map((f, i) => {
                const hot = f.lostPct >= HOT;
                return (
                  <li key={f.step} className="flex items-center gap-4 text-sm">
                    <span className="w-36 shrink-0 text-subtle">{f.label}</span>
                    <Bar pct={peak ? (f.sessions / peak) * 100 : 0} tone={hot ? 'bad' : 'accent'} />
                    <span className="tabular w-14 shrink-0 text-right font-medium">
                      {num(f.sessions)}
                    </span>
                    <span
                      className={`tabular w-16 shrink-0 text-right text-xs ${hot ? 'text-bad' : 'text-subtle'}`}
                    >
                      {i === 0 ? '' : `−${f.lostPct}%`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {worst ? (
            <p className="mt-4 text-sm text-bad">
              Biggest drop at <b>{worst.label}</b> — {pct(worst.lostPct)} of the previous step lost
              there.
            </p>
          ) : null}

          <CardNote>
            “Opened a product” fires no webhook — WhatsApp does not tell a business when its own
            product page is viewed. It is counted from shoppers who reached sizing or sent a cart, so
            it is a floor, not a true figure.
          </CardNote>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Stat
          label="Went quiet"
          value={num(attrition.abandoned)}
          hint="inferred from 24h of silence"
        />
        <Stat label="Opted out" value={num(attrition.optedOut)} hint="exact" />
      </div>

      {attrition.droppedByStep.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Where they stopped</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {attrition.droppedByStep.map((d) => (
                <li key={d.step} className="flex items-center gap-4 text-sm">
                  <span className="w-36 shrink-0 text-subtle">{d.step}</span>
                  <Bar
                    pct={
                      (d.sessions / Math.max(1, ...attrition.droppedByStep.map((x) => x.sessions))) *
                      100
                    }
                  />
                  <span className="tabular w-14 text-right">{num(d.sessions)}</span>
                </li>
              ))}
            </ul>
            <CardNote>
              Meta sends no abandonment event. A shopper who ignores a carousel generates nothing at
              all, so this is inferred from silence rather than received.
            </CardNote>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
