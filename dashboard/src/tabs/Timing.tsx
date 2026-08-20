import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Empty } from '@/components/ui/stat';
import { num } from '@/lib/utils';
import type { AnalyticsData } from '@/lib/api';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

/**
 * When people actually message, for deciding when a campaign goes out.
 *
 * Shifted to IST on the server, not in the browser — the audience is one team
 * in one country, and a heatmap that changes depending on whose laptop is open
 * is worse than no heatmap.
 */
export function Timing({ cells }: { cells: AnalyticsData['hourHeatmap'] }) {
  const byKey = new Map(cells.map((c) => [`${c.dow}|${c.hour}`, c.messages]));
  const peak = Math.max(1, ...cells.map((c) => c.messages));
  const busiest = cells.reduce<(typeof cells)[number] | null>(
    (a, c) => (c.messages > (a?.messages ?? -1) ? c : a),
    null,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>When they message</CardTitle>
        {busiest ? (
          <span className="text-sm text-subtle">
            busiest: {DAYS[busiest.dow]} {String(busiest.hour).padStart(2, '0')}:00 IST
          </span>
        ) : null}
      </CardHeader>

      <CardContent>
        {cells.length === 0 ? (
          <Empty>No inbound messages recorded yet in this window.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="border-separate border-spacing-[2px]">
              <thead>
                <tr>
                  <th />
                  {HOURS.map((h) => (
                    <th key={h} className="w-6 text-[9px] font-normal text-subtle">
                      {h % 6 === 0 ? h : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAYS.map((label, dow) => (
                  <tr key={label}>
                    <td className="pr-2 text-xs text-subtle">{label}</td>
                    {HOURS.map((h) => {
                      const value = byKey.get(`${dow}|${h}`) ?? 0;
                      return (
                        <td key={h}>
                          <div
                            title={`${label} ${String(h).padStart(2, '0')}:00 — ${num(value)} messages`}
                            className="h-6 w-6 rounded-sm"
                            style={{
                              background: value
                                ? `color-mix(in srgb, var(--primary) ${Math.round((value / peak) * 85) + 15}%, transparent)`
                                : 'var(--bg-surface-secondary)',
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <CardNote>
          Times are IST. This is when shoppers message you, which is a reasonable proxy for when
          they are willing to be messaged — but only a proxy, and a campaign sent at the busiest
          hour still needs opt-in.
        </CardNote>
      </CardContent>
    </Card>
  );
}
