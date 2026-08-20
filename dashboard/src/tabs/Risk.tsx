import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Empty, Stat } from '@/components/ui/stat';
import { num } from '@/lib/utils';
import type { AnalyticsData, DashboardData } from '@/lib/api';

const TONE = { GREEN: 'good', YELLOW: 'warn', RED: 'bad', UNKNOWN: 'default' } as const;

/**
 * The tab that exists to stop the number being restricted.
 *
 * Meta drops a messaging tier with little notice, and by the time the rating
 * is RED the entry flow is already failing. What matters is the trend and the
 * opt-out rate — both leading indicators, neither visible in a snapshot.
 */
export function Risk({
  risk,
  health,
  attrition,
}: {
  risk: AnalyticsData['risk'];
  health: DashboardData['health'];
  attrition: DashboardData['attrition'];
}) {
  const broken = health.templates.filter(
    (t) => t.status === 'PAUSED' || t.status === 'DISABLED' || t.quality === 'RED',
  );

  return (
    <>
      {risk.declined ? (
        <div className="rounded-lg border border-bad bg-bad-lt p-4 text-sm">
          <b className="text-bad">Quality has fallen during this window.</b> A rating that dipped and
          recovered still happened, and is the best predictor of the next drop. Look at what was sent
          on those days before sending anything else.
        </div>
      ) : null}

      {broken.length ? (
        <div className="rounded-lg border border-bad bg-bad-lt p-4 text-sm">
          <b className="text-bad">
            {broken.length === 1 ? 'A template is not sending' : `${broken.length} templates are not sending`}
          </b>{' '}
          — {broken.map((t) => `${t.name} (${t.status})`).join(', ')}. The entry flow is broken right
          now and someone has to act today.
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Quality rating"
          value={health.qualityRating ?? '—'}
          tone={TONE[(health.qualityRating as keyof typeof TONE) ?? 'UNKNOWN']}
          hint={health.qualityRating ? undefined : 'needs the nightly Meta pull'}
        />
        <Stat label="Messaging tier" value={health.messagingTier ?? '—'} />
        <Stat
          label="Opted out"
          value={num(attrition.optedOut)}
          tone={attrition.optedOut ? 'warn' : 'default'}
          hint="exact — Meta gives no block list"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Opt-outs by campaign</CardTitle>
          <Badge variant={risk.optOuts.length ? 'warn' : 'default'}>
            {risk.optOuts.reduce((s, o) => s + o.optOuts, 0)} total
          </Badge>
        </CardHeader>
        <CardContent>
          {risk.optOuts.length === 0 ? (
            <Empty>No opt-outs recorded. This is the earliest warning you get before a rating falls.</Empty>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {risk.optOuts.map((o) => (
                <li key={o.templateName} className="flex items-center justify-between py-3">
                  <span>{o.templateName}</span>
                  <span className="tabular font-medium">{num(o.optOuts)}</span>
                </li>
              ))}
            </ul>
          )}
          <CardNote>
            Attributed to the last template that reached the shopper before they left. That is an
            association, not proof — but a template collecting opt-outs is worth reading again
            whatever the cause.
          </CardNote>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rating over time</CardTitle>
        </CardHeader>
        <CardContent>
          {risk.quality.length === 0 ? (
            <Empty>
              No readings yet. Quality and tier come from pulling Meta's API on a schedule, which is
              not wired up — until it is, this tab has no history to show.
            </Empty>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {risk.quality.map((q) => (
                <span
                  key={q.day}
                  title={`${q.day} · ${q.rating}${q.messagingTier ? ` · ${q.messagingTier}` : ''}`}
                  className={`h-8 w-8 rounded ${
                    q.rating === 'GREEN'
                      ? 'bg-good'
                      : q.rating === 'YELLOW'
                        ? 'bg-warn'
                        : q.rating === 'RED'
                          ? 'bg-bad'
                          : 'bg-muted'
                  }`}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
