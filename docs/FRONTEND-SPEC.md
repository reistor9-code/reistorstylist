# Reistor AI Stylist — Dashboard front-end spec

Everything needed to build the dashboard. Self-contained: you should not have to
ask a question to start. A real API response is beside this file at
`dashboard-sample.json` — build against it today, point at the live URL later.

---

## 1. What this is

An internal analytics dashboard for a WhatsApp shopping bot. The bot sells
womenswear in India: a shopper messages the business number, picks an occasion
and a category, gets three product cards, picks a size, and checks out on the
website.

**Audience:** 5–10 people — the founder, the board, and the buying team. Not a
public product, no sign-up, no user accounts.

**Devices:** desktop first, but it gets opened on a phone during meetings. Must
work at 375px.

**One screen.** No navigation, no routing, no drill-downs. Everything on a
single page.

---

## 2. The API

```
GET https://<host>/dashboard/api?token=<DASHBOARD_TOKEN>&days=30
```

One request returns the entire page. **There is no second endpoint.** No
pagination, no per-card fetches, no websockets, no polling required.

### Parameters

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `token` | string | — | **Required.** Also accepted as `Authorization: Bearer <token>` |
| `days` | int | `30` | Clamped to 1–365 |
| `phone` | string | the live number | Filter by WhatsApp number id. `phone=all` includes test traffic |

### Responses

| Status | Body | Show |
| --- | --- | --- |
| `200` | `DashboardData` JSON | the dashboard |
| `403` | `Forbidden` | "Wrong access token" |
| `503` | plain text naming the missing config | the body text verbatim |
| `405` | `Method not allowed` | shouldn't happen — GET only |

Response carries `cache-control: no-store`. Don't add your own caching.

### Two rules that are not negotiable

1. **The browser never talks to the database or to Meta.** All credentials are
   server-side. If you want data that isn't in the response, ask for a backend
   field — do not add a second data source.
2. **Never render a customer phone number.** The API returns none, and it must
   stay that way. Meta's business policy forbids exposing one customer's
   information in another context.

---

## 3. Types

Copy this verbatim — it matches the server exactly.

```ts
export interface DashboardData {
  range: { from: string; to: string; phoneNumberId?: string };
  generatedAt: string;

  funnel: FunnelStep[];
  revenue: Revenue;
  health: Health;
  lostDemand: LostDemand[];
  topProducts: TopProduct[];
  productConversion: ProductConversion[];
  campaigns: CampaignStat[];
  demandGrid: DemandCell[];
  delivery: DeliveryStats;
  cost: CostStats;
  attrition: Attrition;
}

export interface FunnelStep {
  step: string;      // machine key
  label: string;     // display text — use verbatim, do not rewrite
  sessions: number;
  lostPct: number;   // % of the PREVIOUS step lost here; 0 on the first row
}

export interface Revenue {
  orders: number;
  revenueINR: number;          // integer rupees
  averageOrderINR: number;
  costPerOrder: number | null; // BILLED MESSAGES per order — not rupees
}

export interface Health {
  qualityRating: 'GREEN' | 'YELLOW' | 'RED' | null;
  messagingTier: string | null;   // e.g. "TIER_1K"
  capturedAt: string | null;
  templates: { name: string; status: string; quality?: string }[];
}

export interface LostDemand {
  productId: string;
  size: string | null;   // null = every size was gone
  times: number;
  lastAt: string | null;
}

export interface TopProduct {
  productId: string;
  title: string;
  unitsSold: number;
  revenueINR: number;
  orders: number;
  lastSoldAt: string | null;
}

export interface ProductConversion {
  productId: string;
  timesShown: number;
  timesSized: number;
  unitsSold: number;
  conversionPct: number;
}

export interface CampaignStat {
  templateName: string;
  sent: number; delivered: number; read: number; clicked: number;
  readPct: number; clickPct: number;   // both measured against DELIVERED
}

export interface DemandCell {
  occasion: string; category: string;
  requests: number; hadNothing: number; orders: number;
}

export interface DeliveryStats {
  sent: number; delivered: number; read: number; failed: number;
  deliveredPct: number; readPct: number;
}

export interface CostStats {
  billableMessages: number;
  freeMessages: number;
  byCategory: { category: string; messages: number }[];
}

export interface Attrition {
  optedOut: number;    // exact
  abandoned: number;   // inferred
  droppedByStep: { step: string; sessions: number }[];
}
```

**Guarantees:** no key is ever absent · arrays are `[]` not `null` when empty ·
numbers are never `null` except `costPerOrder` · percentages are already
rounded to 1 decimal — **do not round again** · money is integer rupees, never
paise · timestamps are ISO 8601 UTC.

---

## 4. The cards

Eleven cards, in priority order. Row counts are the real server limits, so you
know whether to design a 3-row list or a scrolling table.

### 1. Funnel — the centrepiece
**Always exactly 8 rows. Never more, never fewer.**

Labels are fixed: Started a chat → Picked an occasion → Picked a category → Saw
looks → Opened a product → Picked a size → Opened checkout → Ordered.

Render as horizontal bars sized against row 1, with `sessions` and `lostPct`.

> ⚠️ **Alarm state 1 of 2:** `lostPct >= 50`. This is the number that starts
> board conversations — make it unmissable.

### 2. Sales — 4 figures
`orders` · `revenueINR` · `averageOrderINR` · `costPerOrder`

⚠️ `costPerOrder` is **messages**, not money. Label it "billed msgs / order".
Meta's rupee rate varies by category and country, so a rupee figure here could
not be reconciled against the invoice.

### 3. Account health — 1 pill, 2 values, 2–5 template rows
`qualityRating` as a colour pill · `messagingTier` · plus `attrition.optedOut`
alongside · `templates[]` as a small table.

> ⚠️ **Alarm state 2 of 2:** a template with `status` of `PAUSED` or `DISABLED`,
> or `quality` of `RED`. This means the bot's entry flow is broken **right
> now** and somebody has to act today.

### 4. Lost demand — max 20 rows
`productId` · `size` (`null` = every size gone) · `times` · `lastAt`

The buying team's restock list. Frame as an opportunity, not an error log.

### 5. Top sellers — max 10 rows
`title` · `unitsSold` · `revenueINR` · `orders` · `lastSoldAt`

### 6. Conversion by product — max 25 rows
`timesShown` → `timesSized` → `unitsSold` → `conversionPct`. A 3-stage mini
funnel per row; an inline bar reads better than four bare numbers.

### 7. Campaign performance — 2–5 rows (one per template)
`templateName` · `sent` · `delivered` · `readPct` · `clickPct`

### 8. Demand vs catalog — max 30 rows
5 occasions × 6 categories. Natural fit for a **heatmap**.

- Occasions: `work` `vacation` `casual` `dinner` `lounge`
- Categories: `tops` `dresses` `bottoms` `jackets` `jumpsuits` `coords`

High `hadNothing` = shoppers asked for something the catalog could not supply.

### 9. Delivery — 6 figures
`sent` · `delivered` · `read` · `failed` · `deliveredPct` · `readPct`

### 10. Messages and billing — 2 figures + 2–4 rows
`billableMessages` · `freeMessages` · `byCategory[]` (marketing, utility,
service, authentication)

### 11. Where sessions stopped — 2 figures + ~8 rows
`optedOut` · `abandoned` · `droppedByStep[]`

---

## 5. Caveats that MUST appear on screen

Not fussiness. Presenting any of these as exact would lead a board to a wrong
decision. Use this wording or something equivalent.

| Near | Text |
| --- | --- |
| `delivery.readPct` | "A floor, not a true rate — a shopper with read receipts off never reports a read." |
| Funnel "Opened a product" | "Opening a product page fires no webhook. Counted from shoppers who reached sizing or sent a cart." |
| `attrition.abandoned` | "Inferred from 24 hours of silence. Meta sends no abandonment event." |
| `attrition.optedOut` | Exact — but **never** label it "blocked". Meta provides no block list, only an aggregate quality rating. |
| `revenue.costPerOrder` | "Billed messages per order, not rupees." |
| `cost.*` showing zero | "A test number never bills — these stay at zero until launch." |

---

## 6. States

**Empty is the default for the first week or two.** Every array can be `[]` and
every count `0`. Design this properly; it is what the client will see first.

The cards also fill **unevenly**, because they have two different sources:

| Fills immediately (live webhooks) | Fills next day (nightly job) |
| --- | --- |
| funnel · delivery · lost demand · demand grid · where sessions stopped · billing | revenue · top sellers · conversion · campaigns · account health |

So "half the cards populated, half empty" is a **normal** state, not an error.
Per-card empty copy should say *why*, not "No data". Example from the existing
implementation:

> "No template data yet. Meta keeps read and click counts for only 7 days, so
> this fills in once the nightly pull has run."

**Loading:** one page-level state is fine — it is a single request.

---

## 7. Formatting

**Currency — Indian grouping, not thousands.** `₹1,02,000`, never `₹102,000`.
Lakh and crore. Use this exact function so the front end matches the server:

```ts
function inr(amount: number): string {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return `₹${digits}`;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `₹${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}
// 999 → ₹999 · 2499 → ₹2,499 · 125000 → ₹1,25,000 · 10000000 → ₹1,00,00,000
```

Other rules:

- Percentages arrive pre-rounded to 1dp. Print as given.
- Numeric columns right-aligned, `font-variant-numeric: tabular-nums`.
- Light **and** dark via `prefers-color-scheme`.
- Wide tables scroll inside their own `overflow-x: auto` container. **The page
  body must never scroll sideways.**
- Timestamps: date only is usually enough; the range is already in the header.

---

## 8. Layout

- Single column of cards on mobile; responsive grid on desktop.
- The funnel wants full width. Everything else works in a grid cell.
- **Only two alarm states exist in the entire dashboard** (funnel ≥50% loss,
  paused/RED template). Resist adding more red — if everything shouts, nothing
  is heard.
- No external fonts, CDNs, analytics or tracking. This page shows commercial
  data and should not make third-party requests.

---

## 9. Stack and workflow

Free choice — it consumes one JSON endpoint. A static build is sufficient.

**Development:** import `dashboard-sample.json` and build against it. It is a
real response (verified by running it through the server's own renderer), with
realistic values: 420 sessions → 34 orders, a 52% drop at "opened a product",
and one `PAUSED` template. Good for mocking both a healthy and an alarming
state. Also build the all-zero variant.

**Going live:** swap the import for a `fetch` of `/dashboard/api`. Nothing else
changes.

**Deployment:** served from the same Linux box as the bot, behind nginx.

**Keep all logic out of the front end** — no cron, no business rules, no direct
database access. It reads one endpoint and renders. That keeps credentials on
the server and keeps the app portable if the host changes.

---

## 10. Reference implementation

A working, plain server-rendered version already exists at `GET /dashboard`
(same token). Every card, every caveat and every empty state is implemented and
tested there.

**Treat it as a functional spec, not a visual one.** The numbers, labels and
caveat wording are settled and should not be changed without asking. The design
is entirely yours.
