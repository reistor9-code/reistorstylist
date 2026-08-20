import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bar, Empty, Stat } from '@/components/ui/stat';
import { inr, num, pct } from '@/lib/utils';
import type { AcquisitionRow } from '@/lib/api';

/**
 * Which ad or link produced orders, not just conversations.
 *
 * The base funnel cannot answer this: it has no idea where anybody came from.
 * A source with plenty of chats and no orders is costing money, and it looks
 * identical to a good one until the columns sit side by side.
 */
export function Acquisition({ rows }: { rows: AcquisitionRow[] }) {
  const totals = rows.reduce(
    (a, r) => ({
      sessions: a.sessions + r.sessions,
      orders: a.orders + r.orders,
      revenue: a.revenue + r.revenueINR,
    }),
    { sessions: 0, orders: 0, revenue: 0 },
  );

  const best = rows.reduce<AcquisitionRow | null>(
    (a, r) => (r.orders > (a?.orders ?? -1) ? r : a),
    null,
  );
  const peak = Math.max(1, ...rows.map((r) => r.sessions));

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Chats" value={num(totals.sessions)} hint="all sources" />
        <Stat
          label="Orders"
          value={num(totals.orders)}
          hint={totals.sessions ? `${pct((totals.orders / totals.sessions) * 100)} of chats` : undefined}
        />
        <Stat label="Revenue" value={inr(totals.revenue)} tone={totals.revenue ? 'good' : 'default'} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Where they came from</CardTitle>
          {best ? <Badge variant="accent">best: {best.source}</Badge> : null}
        </CardHeader>

        <CardContent>
          {rows.length === 0 ? (
            <Empty>
              No sources recorded yet. A Click-to-WhatsApp ad fills this automatically; other
              channels need a prefilled link — <code>wa.me/91…?text=Hi%20REISTOR-IG</code> — so the
              code arrives in the first message.
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-subtle">
                  <tr className="border-b border-border">
                    <th className="py-2 text-left font-medium">Source</th>
                    <th className="py-2 text-left font-medium">Campaign</th>
                    <th className="py-2 text-left font-medium">Chats</th>
                    <th className="py-2 text-right font-medium">Orders</th>
                    <th className="py-2 text-right font-medium">Conv.</th>
                    <th className="py-2 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={`${r.source}|${r.campaign}`}>
                      <td className="py-3 capitalize">{r.source}</td>
                      <td className="py-3 text-subtle">{r.campaign}</td>
                      <td className="w-40 py-3">
                        <div className="flex items-center gap-3">
                          <Bar pct={(r.sessions / peak) * 100} />
                          <span className="tabular w-10 text-right">{num(r.sessions)}</span>
                        </div>
                      </td>
                      <td className="tabular py-3 text-right">{num(r.orders)}</td>
                      <td className="tabular py-3 text-right">{pct(r.conversionPct)}</td>
                      <td className="tabular py-3 text-right font-medium">{inr(r.revenueINR)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <CardNote>
            Attribution is captured on the first message of a conversation and never again, so a
            shopper who arrives organically and buys later is counted as organic. Revenue is credited
            to the session that ordered, not the session that first made contact.
          </CardNote>
        </CardContent>
      </Card>
    </>
  );
}
