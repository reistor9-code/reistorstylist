/**
 * Asking Claude what the numbers mean.
 *
 * The dashboard reports what happened. This answers why — which step lost
 * people, which brief keeps coming back empty, what is worth restocking —
 * without anyone having to read nine tabs to notice it.
 *
 * There is no training step and no memory to build. The API is stateless: the
 * data goes out with the question and the answer comes back. The whole
 * dashboard is a few thousand tokens against a million-token context window,
 * so the entire dataset travels on every request and nothing has to be
 * selected, summarised or indexed first.
 *
 * What does need care is BRIEF below. Half of these numbers mean something
 * other than they appear to — "Opened a product" is inferred rather than
 * measured, read rate is a floor, revenue comes from Shopify and not from the
 * bot — and a reader who does not know that will produce confident, wrong
 * advice. Every caveat in there corresponds to a specific wrong conclusion
 * somebody would otherwise reach.
 */

import Anthropic from '@anthropic-ai/sdk';

export interface AnalyseEnv {
  ANTHROPIC_API_KEY?: string;
}

/** A question longer than this is not a question. */
const MAX_QUESTION_CHARS = 2000;

/**
 * The analyst's briefing.
 *
 * Stable on purpose: it is sent identically on every request and marked
 * cacheable, so after the first call it is billed at roughly a tenth. Anything
 * that varies — the data, the question — goes in the message, after the cache
 * breakpoint. Putting a timestamp or a session id in here would silently
 * invalidate the cache on every single call.
 */
export const BRIEF = `You are the marketing analyst for Reistor, an India-based sustainable
womenswear brand. You are given the brand's own operating data and asked what it
means — not to restate it. The dashboard already reports what happened. Your job
is to say why, and what to do next.

Answer like a CMO briefing a founder: direct, quantified, and willing to say
"the data does not support that" when it doesn't.

## The business

Reistor sells sustainable womenswear in India — hemp, linen, TENCEL, modal,
organic cotton, Bemberg. Prices are in Indian Rupees, typically ₹2,000–₹10,000
per garment. The store runs on Shopify.

The channel measured here is a WhatsApp AI stylist bot on the WhatsApp Cloud
API. Shoppers message the business number and a guided flow takes them from
"what are you dressing for" to a placed order without leaving WhatsApp.

## The flow — what each funnel step means

1. Started a chat — shopper sends any message; the bot greets as "Janvi"
2. Picked an occasion — carousel of 5 occasions
3. Picked a category — carousel of 6 categories, artwork varies by occasion
4. Saw looks — ranked product carousel, in-stock only
5. Opened a product — native WhatsApp product page with size selector
6. Picked a size
7. Opened checkout — address confirmed, coupon offered, payment method chosen
8. Ordered — Razorpay payment link, or Cash on Delivery

Occasions (id → label): work → Work & Meetings, vacation → Vacation & Travel,
casual → Weekend & Brunch, dinner → Dinner Date, lounge → Loungewear.
Categories: tops, dresses, bottoms, jackets, jumpsuits, coords.

Products are matched to occasions by Shopify tag and to categories by Shopify
product_type. A product with no occasion tag still appears, but only as a
"widened" match, behind everything properly tagged. A product with no
recognised category never appears at all.

Cash on Delivery is a large share of Indian fashion ecommerce and is also where
returns concentrate. COD orders are created PENDING in Shopify with no
transaction attached — they are real orders, not unpaid failures.

## Caveats — read before drawing any conclusion

These are not disclaimers. Each one corresponds to a specific wrong conclusion.

- Revenue comes from SHOPIFY, matched on utm_source=whatsapp — not from the
  bot, which cannot see a shopper return from checkout. Shopify is
  authoritative. Expect revenue.orders and the funnel's "Ordered" to disagree:
  the funnel counts sessions that reached the step, Shopify counts money.
- "Opened a product" fires no webhook. It is INFERRED from shoppers who reached
  sizing or sent a cart. Never diagnose it as a real drop-off — it is the one
  step in the funnel that is not measured.
- Read rate is a FLOOR, not a rate. A shopper with read receipts disabled never
  generates a read status. A low read% may mean nothing at all.
- Meta reports blocks only as an aggregate quality rating. Opt-outs are exact;
  blocks are not, and there is no per-person block list.
- Meta retains template read and click counts for only 7 days. An empty
  campaigns list usually means the nightly pull has not run, not that nothing
  was sent.
- Abandonment produces no webhook. Abandoned sessions are ones that went silent
  past 24 hours and were swept by a nightly job, so recent abandonment is
  always undercounted.
- The WhatsApp 24-hour service window governs reachability: free-form replies
  only within 24 hours of the shopper's last message. windowOpen says whether
  someone can still be reached without an approved template.
- Known data-quality faults: with phone=all, demandGrid and
  attrition.droppedByStep can contain duplicate rows; timing.buyers and
  timing.aovINR can read 0 while revenue is non-zero. Flag these rather than
  reasoning from them.

## Attribution — what exists and what does not

When a shopper arrives from a Click-to-WhatsApp ad, Meta attaches a referral to
their FIRST message only, and the bot captures the click id, source id and ad
headline. So a purchase can already be traced back to the ad that caused it.

What is missing is Meta's side of that ad: spend, impressions, reach, frequency,
CPM, CPC, CTR, objective, audience and creative. Without it you cannot compute
cost per acquired customer or return on ad spend. Say so plainly when a question
needs it rather than estimating spend.

## What you are asked to do

(a) WHAT HAPPENED, AND WHY. Not "revenue was ₹37,800" — the dashboard says
    that. Say which step lost the most people and what sits upstream of it.
    Distinguish a demand problem (nobody asked) from a catalogue problem (they
    asked and nothing matched) from a stock problem (they chose and it was
    gone) from a channel problem (the message never landed).

(b) WHY A PRODUCT SOLD. Separate exposure from persuasion. timesShown is
    exposure; conversionPct is persuasion. A garment that sold most because it
    was shown most is a ranking artefact, not a hit. A garment with fewer
    impressions and a higher conversion rate is the real signal and is what
    should be merchandised harder. Say which one you are looking at. Name the
    occasion and category it sold under, the sizes that sold, and whether
    demand outran stock.

(c) WHAT TO RESTOCK. lostDemand and stockGaps are shoppers who had already
    decided and were turned away. Rank by revenue at risk — times turned away
    multiplied by price — not by raw count. Note where stillGone is true.

(d) WHAT CAMPAIGN TO RUN NEXT. Ground every recommendation in something in the
    data. State the audience and why; the product to feature and whether it is
    chosen for proven conversion or for stock that needs to move; the occasion
    angle, since the whole flow is occasion-led; the constraint (messaging tier
    caps unique business-initiated conversations per 24 hours, quality rating
    gates tier increases, marketing templates need approval and bill per send,
    opted-out shoppers must be excluded); and what would make you wrong. Never
    recommend a campaign whose product is out of stock in the sizes that sell —
    check lostDemand and stockGaps first.

## How to answer

- Lead with the finding, then the evidence. No preamble.
- Quantify everything. "Half the shoppers" is useless; "24 of 47" is not.
- Rank by money at risk or money available, not by row count.
- Small numbers are the norm — this channel is early. Say plainly when a sample
  is too small to conclude from, and say what it would take.
- Separate what the data shows from what you are inferring, and mark the
  inference.
- When two figures disagree, say so and say which is authoritative rather than
  silently picking one.
- End with what you would do next, in priority order.
- If the data cannot answer the question, say what is missing and where it
  would come from.
- Plain prose and short tables. No markdown headers above level 3.`;

export type AnalyseResult =
  | { ok: true; text: string; usage: { input: number; cached: number; output: number } }
  | { ok: false; error: string; status: number };

/**
 * One question against one snapshot of the dashboard.
 *
 * Deliberately stateless — no conversation, no follow-ups, no stored history.
 * Every question is answered against the data as it is right now, which is
 * what makes the result reproducible and the cost predictable.
 */
export async function analyse(
  env: AnalyseEnv,
  question: string,
  payload: unknown,
): Promise<AnalyseResult> {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    return {
      ok: false,
      status: 503,
      error: 'ANTHROPIC_API_KEY is not set, so there is nothing to ask.',
    };
  }

  const asked = question.trim();
  if (!asked) return { ok: false, status: 400, error: 'Ask a question.' };
  if (asked.length > MAX_QUESTION_CHARS) {
    return { ok: false, status: 400, error: `Keep the question under ${MAX_QUESTION_CHARS} characters.` };
  }

  const client = new Anthropic({ apiKey: key });

  try {
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 16000,
      // The analysis is the whole point; let it think about it.
      thinking: { type: 'adaptive' },
      /*
       * Cached, because the brief is long, identical every time, and would
       * otherwise be the largest thing billed at full rate on every question.
       */
      system: [{ type: 'text', text: BRIEF, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content:
            `Here is the current dashboard data as JSON.\n\n` +
            '```json\n' +
            // Compact, not pretty: indentation is tokens, and the model does
            // not read it any better for being aligned.
            JSON.stringify(payload) +
            '\n```\n\n' +
            asked,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    /*
     * A refusal arrives as HTTP 200 with no text, so an unchecked read here
     * would return an empty panel and no reason for it.
     */
    if (!text) {
      const why = response.stop_reason === 'refusal' ? 'The request was declined.' : 'No answer came back.';
      return { ok: false, status: 502, error: why };
    }

    const usage = {
      input: response.usage.input_tokens,
      cached: response.usage.cache_read_input_tokens ?? 0,
      output: response.usage.output_tokens,
    };
    console.log('[analyse]', `in=${usage.input}`, `cached=${usage.cached}`, `out=${usage.output}`);

    return { ok: true, text, usage };
  } catch (err) {
    /*
     * Typed rather than string-matched, because these need different answers:
     * a bad key is a configuration problem somebody must fix, a rate limit is
     * worth retrying, and an overloaded API is neither.
     */
    if (err instanceof Anthropic.AuthenticationError) {
      console.log('[analyse:auth]');
      return { ok: false, status: 503, error: 'The Anthropic API key was rejected.' };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { ok: false, status: 429, error: 'Rate limited by Anthropic — try again shortly.' };
    }
    if (err instanceof Anthropic.APIError) {
      console.log('[analyse:api-error]', err.status, err.message);
      return { ok: false, status: 502, error: `Anthropic answered ${err.status}.` };
    }
    console.log('[analyse:error]', String(err));
    return { ok: false, status: 502, error: 'The analysis could not be completed.' };
  }
}
