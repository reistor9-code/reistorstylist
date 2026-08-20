import * as React from 'react';
import { Phone, Check } from 'lucide-react';
import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/ui/stat';
import { markCalled, type Callback } from '@/lib/api';

const pretty = (waId: string): string => {
  const d = waId.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : `+${d}`;
};

/**
 * The only tab that is a to-do list rather than a report.
 *
 * Every row is a person the bot promised a call to within 24 hours, so it
 * leads the dashboard and the overdue ones are marked in red — the promise is
 * already broken by the time it turns.
 */
export function ActionQueue({ callbacks, onChange }: { callbacks: Callback[]; onChange: () => void }) {
  const [saving, setSaving] = React.useState<number | null>(null);
  const overdue = callbacks.filter((c) => c.overdue).length;

  async function handle(id: number) {
    setSaving(id);
    try {
      await markCalled(id);
      onChange();
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Call these people</CardTitle>
        <Badge variant={overdue ? 'bad' : 'default'}>
          {callbacks.length} waiting{overdue ? ` · ${overdue} overdue` : ''}
        </Badge>
      </CardHeader>

      <CardContent>
        {callbacks.length === 0 ? (
          <Empty>Nobody is waiting for a call. This fills the moment somebody taps “Talk to Stylist”.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {callbacks.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="tabular font-medium">{pretty(c.waId)}</span>
                    {c.overdue ? <Badge variant="bad">past 24h</Badge> : null}
                    {c.marketingOptOut ? (
                      <Badge variant="warn">opted out — this request only</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-subtle">
                    {c.profileName || 'No profile name'}
                    {c.occasion || c.category
                      ? ` · was browsing ${[c.occasion, c.category].filter(Boolean).join(' · ')}`
                      : ''}
                    {c.productsSeen.length ? ` · saw ${c.productsSeen.length} looks` : ''}
                  </p>
                  <p className="mt-0.5 text-xs text-subtle">
                    waiting {c.hoursWaiting < 1 ? 'under an hour' : `${Math.round(c.hoursWaiting)}h`}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <a href={`tel:+${c.waId.replace(/\D/g, '')}`}>
                    <Button size="sm" variant="default">
                      <Phone size={14} /> Call
                    </Button>
                  </a>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saving === c.id}
                    onClick={() => handle(c.id)}
                  >
                    <Check size={14} /> {saving === c.id ? 'Saving…' : 'Mark called'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <CardNote>
          The bot promises a call within 24 hours. These numbers came from shoppers who messaged
          first and asked to be rung — use them for that, and nothing else. Asking for a callback is
          not opting into marketing.
        </CardNote>
      </CardContent>
    </Card>
  );
}
