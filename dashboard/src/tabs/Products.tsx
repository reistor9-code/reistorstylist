import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bar, Empty } from '@/components/ui/stat';
import { inr, num, pct } from '@/lib/utils';
import type { AnalyticsData, DashboardData } from '@/lib/api';

/**
 * What a row is called.
 *
 * Title first, SKU second, the raw Shopify id only when the catalogue has
 * never heard of the product. A bare id is unreadable to whoever is deciding
 * what to reorder.
 */
const name = (p: { title: string | null; productId: string }) => p.title || `Product ${p.productId}`;

const Ident = ({ p }: { p: { title: string | null; sku: string | null; productId: string } }) => (
  <span className="flex min-w-0 items-baseline gap-2">
    <span className="min-w-0 truncate">{name(p)}</span>
    {p.sku ? <span className="tabular shrink-0 text-xs text-subtle">{p.sku}</span> : null}
  </span>
);

/**
 * What sells, what does not, and what you could not sell because it was gone.
 *
 * Conversion sits beside volume deliberately: a product shown two hundred
 * times and sold twice is occupying carousel slots that something else could
 * use, and volume alone never shows that.
 */
export function Products({
  topProducts,
  conversion,
  stockGaps,
  lostDemand,
}: {
  topProducts: DashboardData['topProducts'];
  conversion: DashboardData['productConversion'];
  stockGaps: AnalyticsData['stockGaps'];
  lostDemand: DashboardData['lostDemand'];
}) {
  const worst = [...conversion].sort((a, b) => a.conversionPct - b.conversionPct).slice(0, 8);

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Best sellers</CardTitle>
            <Badge variant="accent">{topProducts.length}</Badge>
          </CardHeader>
          <CardContent>
            {topProducts.length === 0 ? (
              <Empty>
                No sales recorded yet. Revenue comes from the nightly Shopify pull, so it lands a day
                after the funnel does.
              </Empty>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {topProducts.map((p) => (
                  <li key={p.productId} className="flex items-center justify-between gap-4 py-3">
                    <Ident p={p} />
                    <span className="flex shrink-0 items-center gap-3">
                      <Badge>{num(p.unitsSold)} sold</Badge>
                      <span className="tabular font-medium">{inr(p.revenueINR)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Worst converters</CardTitle>
            <Badge variant="warn">shown often, rarely bought</Badge>
          </CardHeader>
          <CardContent>
            {worst.length === 0 ? (
              <Empty>Needs both a shown-count and an order against the same product.</Empty>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {worst.map((p) => (
                  <li key={p.productId} className="py-3">
                    <div className="flex items-center justify-between gap-4">
                      <Ident p={p} />
                      <span className="tabular shrink-0 text-subtle">
                        {pct(p.conversionPct)}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-3 text-xs text-subtle">
                      <Bar pct={p.timesShown ? (p.unitsSold / p.timesShown) * 100 : 0} />
                      <span className="tabular shrink-0">
                        {num(p.timesShown)} shown · {num(p.unitsSold)} sold
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Restock list</CardTitle>
          <Badge variant={stockGaps.some((g) => g.stillGone) ? 'bad' : 'default'}>
            {stockGaps.length || lostDemand.length} sizes
          </Badge>
        </CardHeader>
        <CardContent>
          {stockGaps.length === 0 && lostDemand.length === 0 ? (
            <Empty>
              Nothing has sold out on a shopper yet. This fills as soon as somebody reaches sizing
              and their size is gone.
            </Empty>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {(stockGaps.length ? stockGaps : lostDemand.map(toGap)).map((g) => (
                <li
                  key={`${g.productId}|${g.size}`}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <span className="min-w-0 truncate">{name(g)}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <Badge variant={g.size === null ? 'bad' : 'warn'}>
                      {g.size === null ? 'every size' : `size ${g.size}`}
                    </Badge>
                    <span className="tabular text-subtle">
                      {num(g.turnedAway)} turned away
                    </span>
                    {g.stillGone ? <Badge variant="bad">still out</Badge> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <CardNote>
            Demand you could not serve, not a failure log — every row is somebody who had chosen the
            garment and was ready to buy. “Still out” compares against the last stock snapshot.
          </CardNote>
        </CardContent>
      </Card>
    </>
  );
}

/** Lost demand without a stock snapshot behind it, so `stillGone` is unknown. */
const toGap = (l: DashboardData['lostDemand'][number]): AnalyticsData['stockGaps'][number] => ({
  productId: l.productId,
  title: l.sku ? `${l.title ?? `Product ${l.productId}`} · ${l.sku}` : l.title,
  size: l.size,
  turnedAway: l.times,
  stockNow: 0,
  stillGone: false,
});
