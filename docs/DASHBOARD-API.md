# Dashboard API — front-end brief

Hand this whole file to whoever builds the front end. It describes everything
the backend provides, and `docs/dashboard-sample.json` beside it is a real
response you can develop against before the server is reachable.

---

## What this is

An internal analytics dashboard for **Reistor AI Stylist**, a WhatsApp shopping
bot. Roughly 5–10 viewers: the founder, the board, and the buying team. Not a
public product. Desktop first, but it will be opened on a phone in a meeting,
so it has to work at 375px.

## The whole API is one endpoint

```
GET https://<host>/dashboard/api?token=<DASHBOARD_TOKEN>&days=30
```

Returns the entire page as one JSON object. **There is no second call.** No
pagination, no per-tile endpoints, no websockets.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `token` | — | **Required.** Shared secret. Also accepted as `Authorization: Bearer <token>` |
| `days` | `30` | Window size, 1–365 |
| `phone` | the live number | Phone number id to filter by. `phone=all` includes test traffic |

Responses: `200` with the payload · `403` wrong or missing token · `503`
backend not configured yet (body is a plain-text reason) · `405` non-GET.

### Two rules that are not negotiable

1. **The browser never talks to Supabase or Meta directly.** All credentials
   live server-side. If you find yourself wanting a database key in the
   front-end, the answer is a new backend field instead.
2. **Never render a shopper's phone number.** The API does not return any, and
   it must stay that way — Meta's policy forbids exposing one customer's data
   in another context.

---

## Response shape

TypeScript, matching the server exactly:

```ts
interface DashboardData {
  range: { from: string; to: string; phoneNumberId?: string };  // ISO dates
  generatedAt: string;                                          // ISO timestamp

  funnel: {
    step: string;        // machine key, e.g. "picked_size"
    label: string;       // display label, already written — use it verbatim
    sessions: number;
    lostPct: number;     // % of the PREVIOUS step lost here. 0 on the first row
  }[];

  revenue: {
    orders: number;
    revenueINR: number;        // rupees, integer
    averageOrderINR: number;
    costPerOrder: number | null;   // BILLED MESSAGES per order, not rupees
  };

  topProducts: {
    productId: string;
    title: string;
    unitsSold: number;
    revenueINR: number;
    orders: number;
    lastSoldAt: string | null;
  }[];

  productConversion: {
    productId: string;
    timesShown: number;
    timesSized: number;
    unitsSold: number;
    conversionPct: number;   // already rounded to 1dp
  }[];

  lostDemand: {
    productId: string;
    size: string | null;   // null = every size was gone
    times: number;
    lastAt: string | null;
  }[];

  demandGrid: {
    occasion: string;      // work | vacation | casual | dinner | lounge
    category: string;      // tops | dresses | bottoms | jackets | jumpsuits | coords
    requests: number;
    hadNothing: number;    // times the catalog had no match
    orders: number;
  }[];

  campaigns: {
    templateName: string;
    sent: number; delivered: number; read: number; clicked: number;
    readPct: number; clickPct: number;   // both measured against DELIVERED
  }[];

  delivery: {
    sent: number; delivered: number; read: number; failed: number;
    deliveredPct: number; readPct: number;
  };

  cost: {
    billableMessages: number;
    freeMessages: number;
    byCategory: { category: string; messages: number }[];
  };

  attrition: {
    optedOut: number;      // exact
    abandoned: number;     // inferred
    droppedByStep: { step: string; sessions: number }[];
  };

  health: {
    qualityRating: 'GREEN' | 'YELLOW' | 'RED' | null;
    messagingTier: string | null;    // e.g. "TIER_1K"
    capturedAt: string | null;
    templates: { name: string; status: string; quality?: string }[];
  };
}
```

All percentages are **pre-rounded to one decimal** — do not round again. All
money is **integer rupees** — no paise anywhere.

---

## The tiles, in priority order

**1. Funnel — the most important thing on the page.** A horizontal bar per
step, plus the `lostPct` drop between steps. Anything `lostPct >= 50` should be
visually alarming; that is the number that starts the conversation. Use `label`
as given.

**2. Sales.** Orders · revenue · average order · billed messages per order.

**3. Lost demand.** Products where a shopper reached sizing and the size was
gone. Frame it as a **restock list**, not a failure log — the buying team reads
this one. `size: null` means every size was out.

**4. Account health.** Quality rating as a colour pill (GREEN/YELLOW/RED),
messaging tier, opt-out count, and the template table. **A template with status
`PAUSED` or `DISABLED`, or quality `RED`, must be impossible to miss** — that
state means the bot's entry flow is broken right now and someone has to act.

**5. Top sellers · 6. Conversion by product · 7. Campaign performance ·
8. Demand vs catalog · 9. Delivery · 10. Messages and billing · 11. Where
sessions stopped.**

---

## Caveats you MUST surface in the UI

These are not fussiness — presenting any of these as exact would mislead a
board into a wrong decision.

| Field | What to show near it |
| --- | --- |
| `delivery.readPct` | "A floor, not a true rate — a shopper with read receipts off never reports a read." |
| `funnel` "Opened a product" | "Opening a product page fires no webhook. Counted from shoppers who reached sizing or sent a cart." |
| `attrition.abandoned` | "Inferred from 24 hours of silence. Meta sends no abandonment event." |
| `attrition.optedOut` | Exact — but never label it "blocked". Meta gives no block list, only the aggregate quality rating. |
| `revenue.costPerOrder` | **Messages**, not rupees. Label it "billed msgs / order". |
| `cost.*` at zero | "A test number never bills — these stay at zero until launch." |

---

## States to design

- **Loading** — one page-level state is fine; it is a single request.
- **Empty** — very likely early on. Every array can be `[]` and every count
  `0`. Write per-tile empty copy that explains *why* it is empty rather than
  "No data". The server's own wording is a good model: *"No template data yet.
  Meta keeps read and click counts for only 7 days, so this fills in once the
  nightly pull has run."*
- **Partially empty** — normal. Campaigns and revenue populate a day after the
  funnel does, because they come from a nightly job rather than live webhooks.
- **403** — "Wrong access token."
- **503** — show the plain-text body; it names the missing configuration.

## Design constraints

- Light **and** dark, via `prefers-color-scheme`.
- Numeric columns right-aligned, tabular figures.
- Wide tables scroll inside their own container — the page must never scroll
  sideways.
- Currency: Indian grouping, `₹1,02,000` not `₹102,000`. Lakh/crore, not
  thousands. The server already formats this way; if you format client-side,
  match it.
- No external fonts, CDNs or tracking. This page shows commercial data and
  should not phone anyone.

## Reference implementation

A working server-rendered version already exists at `GET /dashboard` (same
token). It is deliberately plain — every tile, every caveat and every empty
state is there, and it is the source of truth for wording. **Treat it as a
functional spec, not as a visual one.** The design is yours; the numbers, the
labels and the caveats are not.

## Stack

Free choice — it consumes one JSON endpoint. Notes:

- It will be served from the same Linode box as the bot, behind nginx.
- **Keep the cron and all business logic out of the front end.** The front end
  reads and renders; nothing else. That keeps it portable and keeps credentials
  on the server.
- A static build talking to `/dashboard/api` is entirely sufficient.
