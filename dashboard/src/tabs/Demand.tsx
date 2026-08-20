import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Empty } from '@/components/ui/stat';
import { num } from '@/lib/utils';
import type { AnalyticsData, DashboardData } from '@/lib/api';

const OCCASIONS = ['work', 'vacation', 'casual', 'dinner', 'lounge'];
const CATEGORIES = ['tops', 'dresses', 'bottoms', 'jackets', 'jumpsuits', 'coords'];

/**
 * What shoppers asked for, and what the catalogue could not answer.
 *
 * A red cell is a pair somebody wanted and the shelf could not serve. A blank
 * cell is not a zero — it is a question nobody asked in this window, and the
 * two must not look alike.
 */
export function Demand({
  grid,
  searchMisses,
}: {
  grid: DashboardData['demandGrid'];
  searchMisses: AnalyticsData['searchMisses'];
}) {
  const byKey = new Map(grid.map((c) => [`${c.occasion}|${c.category}`, c]));
  const peak = Math.max(1, ...grid.map((c) => c.requests));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Demand vs catalogue</CardTitle>
          <Badge>what they asked for</Badge>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-subtle">
                <tr>
                  <th className="py-2 text-left font-medium" />
                  {CATEGORIES.map((c) => (
                    <th key={c} className="py-2 text-center font-medium capitalize">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {OCCASIONS.map((o) => (
                  <tr key={o}>
                    <td className="py-2 pr-3 capitalize text-subtle">{o}</td>
                    {CATEGORIES.map((c) => {
                      const cell = byKey.get(`${o}|${c}`);
                      if (!cell) return <td key={c} className="p-1" />;
                      const miss = cell.requests ? cell.hadNothing / cell.requests : 0;
                      const heat = 0.12 + (cell.requests / peak) * 0.5;
                      return (
                        <td key={c} className="p-1">
                          <div
                            title={`${cell.requests} asked · ${cell.hadNothing} had nothing · ${cell.orders} ordered`}
                            className="rounded-md px-2 py-3 text-center"
                            style={{
                              background: `color-mix(in srgb, var(--${miss >= 0.5 ? 'red' : 'primary'}) ${Math.round(heat * 100)}%, transparent)`,
                            }}
                          >
                            <div className="tabular font-medium">{num(cell.requests)}</div>
                            <div className="text-[10px] text-subtle">
                              {cell.hadNothing ? `${cell.hadNothing} empty` : `${cell.orders} sold`}
                            </div>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CardNote>
            Red cells are pairs the catalogue could not answer. Blank cells were never asked for in
            this window — which is not the same as having nothing to sell.
          </CardNote>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What they asked for and did not get</CardTitle>
          <Badge variant={searchMisses.length ? 'warn' : 'default'}>{searchMisses.length}</Badge>
        </CardHeader>
        <CardContent>
          {searchMisses.length === 0 ? (
            <Empty>
              Nothing typed that the bot could not answer. This fills with the words shoppers use
              when the buttons do not cover what they want.
            </Empty>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {searchMisses.map((m) => (
                <li key={m.normalised} className="flex items-center justify-between gap-4 py-3">
                  <span className="min-w-0">
                    <span className="truncate">“{m.example}”</span>
                    {m.lastStep ? (
                      <span className="ml-2 text-xs text-subtle">at {m.lastStep}</span>
                    ) : null}
                  </span>
                  <span className="tabular shrink-0 text-subtle">
                    {num(m.times)}× · {num(m.shoppers)} people
                  </span>
                </li>
              ))}
            </ul>
          )}
          <CardNote>
            The most direct product feedback here: occasions you do not offer, categories you do not
            stock, and questions nobody has written an answer for.
          </CardNote>
        </CardContent>
      </Card>
    </>
  );
}
