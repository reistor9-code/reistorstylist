import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Stat } from '@/components/ui/stat';
import { inr, num, pct } from '@/lib/utils';
import type { AnalyticsData, DashboardData } from '@/lib/api';

const minutes = (m: number | null): string => {
  if (m === null) return '—';
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 24 ? `${Math.round(h * 10) / 10} h` : `${Math.round((h / 24) * 10) / 10} days`;
};

/** Money, and how long it takes to arrive. */
export function Revenue({
  revenue,
  timing,
  callbackOutcome,
  cost,
}: {
  revenue: DashboardData['revenue'];
  timing: AnalyticsData['timing'];
  callbackOutcome: AnalyticsData['callbackOutcome'];
  cost: DashboardData['cost'];
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Orders" value={num(revenue.orders)} />
        <Stat label="Revenue" value={inr(revenue.revenueINR)} tone={revenue.revenueINR ? 'good' : 'default'} />
        <Stat label="Average order" value={inr(revenue.averageOrderINR)} />
        <Stat
          label="Per order"
          value={revenue.costPerOrder === null ? '—' : `${num(revenue.costPerOrder)} msgs`}
          hint="billed messages, not rupees"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Typical time to buy" value={minutes(timing.medianMinutes)} hint="weighted median" />
        <Stat label="Slowest 10%" value={minutes(timing.p90Minutes)} />
        <Stat
          label="Repeat buyers"
          value={pct(timing.repeatPct)}
          hint={`${num(timing.repeatBuyers)} of ${num(timing.buyers)} buyers`}
          tone={timing.repeatPct >= 20 ? 'good' : 'default'}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Does the stylist close?</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat label="Requests" value={num(callbackOutcome.requests)} />
            <Stat label="Called" value={num(callbackOutcome.called)} />
            <Stat label="Orders after" value={num(callbackOutcome.ordersAfter)} />
            <Stat label="Revenue after" value={inr(callbackOutcome.revenueINR)} />
          </div>
          <CardNote>
            An order after a callback is not proof the call caused it — nothing here can prove that.
            It is the same shopper ordering later, which is the closest the data gets.
          </CardNote>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Message cost</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <Stat label="Billable" value={num(cost.billableMessages)} />
            <Stat label="Free" value={num(cost.freeMessages)} hint="inside the 24h window" />
          </div>
          <CardNote>
            Counted in messages rather than rupees. Meta's price varies by category and country, so a
            rupee figure here would be a guess — multiply by your own rate.
            {cost.billableMessages === 0
              ? ' A test number never bills; these stay at zero until launch.'
              : ''}
          </CardNote>
        </CardContent>
      </Card>
    </>
  );
}
