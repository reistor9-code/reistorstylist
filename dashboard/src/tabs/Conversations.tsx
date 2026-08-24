import * as React from 'react';
import { Card, CardContent, CardHeader, CardNote, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Empty } from '@/components/ui/stat';
import { fetchTranscript, type Conversation, type Message } from '@/lib/api';

const pretty = (waId: string): string => {
  const d = waId.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : `+${d}`;
};

const time = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * What a shopper actually said.
 *
 * The transcript is fetched per shopper rather than shipped with the report:
 * every other tab is aggregate, and pushing every message of every
 * conversation to the browser to render one of them would send far more
 * personal data than the reader asked for.
 */
export function Conversations({ chats }: { chats: Conversation[] }) {
  const [selected, setSelected] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Message[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  function open(waId: string) {
    setSelected(waId);
    setMessages(null);
    setLoading(true);
    fetchTranscript(waId)
      .then(setMessages)
      .finally(() => setLoading(false));
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Shoppers</CardTitle>
          <Badge>{chats.length}</Badge>
        </CardHeader>
        <CardContent>
          {chats.length === 0 ? (
            <Empty>No conversations in this window.</Empty>
          ) : (
            <ul className="-mx-2 max-h-[32rem] space-y-0.5 overflow-y-auto">
              {chats.map((c) => (
                <li key={c.waId}>
                  <button
                    type="button"
                    onClick={() => open(c.waId)}
                    className={`w-full rounded-md px-2 py-2 text-left text-sm transition-colors ${
                      selected === c.waId ? 'bg-muted text-text' : 'hover:bg-muted'
                    }`}
                  >
                    <span className="tabular block">{pretty(c.waId)}</span>
                    <span className="block text-xs text-subtle">
                      {c.lastStep ?? '—'} · {time(c.lastAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{selected ? pretty(selected) : 'Transcript'}</CardTitle>
          {messages ? <Badge>{messages.length} messages</Badge> : null}
        </CardHeader>
        <CardContent>
          {!selected ? (
            <Empty>Pick a shopper to read the conversation.</Empty>
          ) : loading ? (
            <Empty>Loading…</Empty>
          ) : !messages?.length ? (
            <Empty>
              No messages stored for this shopper. Text older than 90 days is stripped by the
              retention sweep, which leaves the conversation counted but unreadable.
            </Empty>
          ) : (
            <div className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
              {messages.map((m, i) => {
                const inbound = m.direction === 'in';
                return (
                  <div
                    key={`${m.ts}-${i}`}
                    className={`flex ${inbound ? 'justify-start' : 'justify-end'}`}
                  >
                    <div
                      className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                        inbound ? 'bg-muted' : 'bg-accent-lt'
                      }`}
                    >
                      {/* Picker cards are written out one per line, so newlines
                          in the body are meaningful. */}
                      <div className="whitespace-pre-line">
                        {m.body ?? (
                          <span className="italic text-subtle">
                            {m.payloadId ? `tapped ${m.payloadId}` : `[${m.messageType ?? 'no text'}]`}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[10px] text-subtle">
                        {time(m.ts)}
                        {m.flowStep ? ` · ${m.flowStep}` : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <CardNote>
            Message text is kept for 90 days and then stripped, leaving the event so the funnel
            keeps counting a conversation whose words are gone. These are real customers — the
            transcript is here to answer “what went wrong in this chat”, not to be exported.
          </CardNote>
        </CardContent>
      </Card>
    </div>
  );
}
