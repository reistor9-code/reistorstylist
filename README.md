# Reistor AI Stylist — WhatsApp prototype

A single Cloudflare Worker that runs the Reistor AI Stylist on the **Meta WhatsApp Cloud API**
(Graph API v21.0), with the **Anthropic API** doing the look ranking and the free-text stylist.
India store: prices in INR, womenswear.

```
src/index.ts      the whole bot — webhook, state machine, send helpers, Claude calls
src/products.json 24 mock products behind getProducts()
wrangler.toml     KV binding + vars
```

---

## 1. Install

```sh
npm install
```

## 2. Create the KV namespace

State is stored per WhatsApp `wa_id`.

```sh
npx wrangler kv namespace create STATE
npx wrangler kv namespace create STATE --preview
```

Each command prints an id. Paste them into `wrangler.toml` — deploy fails while the
`REPLACE_WITH_…` placeholders are still there:

```toml
[[kv_namespaces]]
binding = "STATE"
id = "<id from the first command>"
preview_id = "<id from the second command>"
```

## 3. Deploy

```sh
npx wrangler deploy
```

Wrangler prints the Worker URL, e.g. `https://reistor-ai-stylist.<subdomain>.workers.dev`.

Deploying before setting secrets is deliberate: `wrangler secret put` needs the Worker to exist,
and otherwise prompts to create a placeholder one first. (Answering yes to that prompt is fine
too — the next deploy fills it in.)

## 4. Set the secrets

```sh
npx wrangler secret put WHATSAPP_TOKEN     # Meta access token
npx wrangler secret put PHONE_NUMBER_ID    # WhatsApp Business phone number id — not the number
npx wrangler secret put VERIFY_TOKEN       # any string you choose
npx wrangler secret put ANTHROPIC_API_KEY  # optional — see "Running without Claude"
```

Each command prompts for the value and stores it encrypted; nothing is written to disk. Check with
`npx wrangler secret list`. Secrets apply immediately — no redeploy needed.

For local `wrangler dev`, put the same four in a `.dev.vars` file (copy `.dev.vars.example`).

`WHATSAPP_TOKEN`, `PHONE_NUMBER_ID` and the test recipient list all live in Meta App Dashboard →
**WhatsApp → API Setup**. The temporary token there expires after 24 hours; for a lasting one,
Business Settings → System Users → add the WhatsApp app as an asset → generate a token with
`whatsapp_business_messaging` and `whatsapp_business_management`.

## 5. Point Meta at it

Meta App Dashboard → **WhatsApp → Configuration → Edit** on the Webhook row:

| Field | Value |
| --- | --- |
| Callback URL | `https://reistor-ai-stylist.<subdomain>.workers.dev/webhook` |
| Verify token | the exact string you set as `VERIFY_TOKEN` |

Click **Verify and save** — the Worker answers the `hub.challenge` handshake. Then under
**Webhook fields**, click **Manage** and subscribe to **`messages`**. That single field carries
inbound texts and interactive replies.

Message the business number from your phone and send `hi`.

Live logs while testing:

```sh
npx wrangler tail
```

Every inbound and outbound payload is logged (`[inbound]`, `[outbound]`, `[outbound:response]`).

---

## The flow

```
WELCOME ──▶ SELECT OCCASION ──▶ SELECT CATEGORY ──▶ BACKEND (filter → rank via Claude)
                                                          │
                                                          ▼
                                                  TOP 3 (image + caption)
                                                          │
                             ┌────────────────┬───────────┴──────┬──────────────────┐
                             ▼                ▼                  ▼                  ▼
                    View & Select Size   Show More Looks   Browse Same Cat.   Talk to Stylist
                             │                │                  │                  │
                        pick 1/2/3       next 3, loop      paginate + pick     free text ⇄ Claude
                             ▼                                   │              (Back to looks)
                     size list (in-stock only)                   │
                             ▼                                   ▼
                   CTA-URL "Buy Now" → GoKwik ────────▶ size list
                             ▼
                     Order Confirmed! → Browse Again / End Chat
```

The occasion and category steps are **carousels** (see below). Card bodies are static, so they
carry no live counts — picking *Dinner Date* then *Tops* reaches the empty state via
`nothingForCombo` rather than being greyed out up front.

Current catalog coverage (in-stock only):

| Occasion | Tops | Dresses | Bottoms | Jackets | Jumpsuits | Co-ords | Total |
| --- | --: | --: | --: | --: | --: | --: | --: |
| Work & Meeting | 6 | 2 | 3 | 1 | 1 | 0 | 13 |
| Vacation & Travel | 4 | 3 | 2 | 0 | 2 | 0 | 11 |
| Casual & Brunch | 5 | 3 | 3 | 1 | 2 | 0 | 14 |
| Dinner Date | 0 | 1 | 0 | 0 | 1 | 0 | 2 |
| Loungewear | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

*Work & Meeting → Tops* has 6, so **Show More Looks** has somewhere to go. One product
(`linen-cropped-jacket`) is sold out in every size to exercise the in-stock filter.

## Carousel pickers

The occasion and category steps render as **carousels**. WhatsApp has no carousel for free-form
messages, so each one is an approved **Marketing template** — `occasion_picker` and
`category_picker`, both approved and Active on the Test WhatsApp Business Account.

There is no list picker. If a carousel send is rejected — template paused on quality, or the
shopper has opted out of marketing — the Worker logs `[carousel:rejected]` and asks for the
answer as text instead. The typed-name shortcut in `handleText()` matches those replies against
the `OCCASIONS` / `CATEGORIES` labels, so the flow still advances.

### How the templates were created

WhatsApp Manager does not expose the carousel component in every account — if *Add button* is the
last thing on the template editor, yours is one of them. Create them through the Cloud API
instead, using the built-in route:

```
/admin/templates?token=<VERIFY_TOKEN>&waba=<WABA_ID>&app=<APP_ID>
```

It uploads an example image via Meta's resumable upload, then creates and submits both templates
with the token already in your Worker. Re-running is safe — a duplicate name errors rather than
creating anything. Delete the route once the templates exist.

The token needs **`whatsapp_business_management`**, which the API Setup temporary token carries and
a System User token only carries if you ticked it.

What gets created:

| | `occasion_picker` | `category_picker` |
| --- | --- | --- |
| Category | Marketing (carousel is Marketing-only) | Marketing |
| Language | `en_US` (matches `TEMPLATE_LANGUAGE`) | same |
| Body | `What's the occasion?` | `What type of clothing are you looking for?` |
| Cards | 5 | 6 |

Every card has the same structure — an **image** header (mandatory; carousel cards cannot be
text-only), a static body of `label` + `blurb`, and one **quick reply** button labelled `Choose`.
The routing payload (`occ:work`, `cat:tops`, …) is attached per card at send time, so it isn't
baked into the approved template.

**Card bodies carry no `{{n}}` variables, deliberately.** Meta weighs a template's total variable
count against its main body length, and a carousel's body is one short question — so a per-card
count variable is rejected with *"Parameters words ratio exceeds limit"* however long the card copy
is. That is why the pickers show no live counts.

**Card order must match the `OCCASIONS` and `CATEGORIES` arrays in `src/index.ts`** — cards are
addressed by index, so reordering one without the other silently mismatches the labels.

Card images and blurbs come from those same arrays (placeholder `picsum.photos` seeds out of the
box). Swap the images for real artwork; they must be public https URLs.

### What it costs

A Marketing template is billed per delivered message — roughly **₹0.86–0.88** in India at Meta's
direct rate. Occasion + category are two paid messages per shopper per session, so ~**₹1.75 per
session** before anyone has seen a product. Everything downstream (looks, sizes, checkout) is
free-form and unbilled.

Meta's **test number does not bill**, so the current setup runs end to end at zero cost.

## State

One KV record per `wa_id`, 7-day TTL:

```ts
{ step, occasion, category, offset, mode: 'flow' | 'stylist', currentLookId, shownLookIds[],
  rankedIds[], reasons{}, browseOffset, stylistTurns[], updatedAt }
```

The first seven fields are the ones from the spec. `rankedIds`/`reasons` cache the ranking so
"Show More Looks" can page past the top 3 without re-calling Claude; `browseOffset` is a second
cursor so browsing does not disturb the ranked edit; `stylistTurns` keeps the last few turns of
stylist chat. Inbound message ids are also cached for 10 minutes so Meta's webhook retries do not
double-send.

## Swapping in real products

Everything reads the catalog through one function:

```ts
export async function getProducts(_env: Env): Promise<Product[]>
```

It is already `async`, so replacing the body with a Shopify Admin API query (products + variant
inventory mapped into `Product`) needs no changes anywhere in the flow. Per-size stock lives in
`sizes: [{ size, stock }]`, which maps onto Shopify variants directly.

**Images are placeholders.** `products.json` points at `picsum.photos` seeds so the image messages
actually render during a demo. Swap `imageUrl` for real Reistor CDN URLs — Meta fetches the URL
server-side, so it has to be public. If a fetch fails, `sendImage` falls back to a text message
with the caption and link rather than dropping the look.

`productUrl` is a `reistor.in` product page; `checkoutUrl()` appends `?variant=<size>` plus UTM
params for the GoKwik deep link. Point it at your real checkout URL shape there.

## Claude

| Step | Call |
| --- | --- |
| Ranking | `claude-sonnet-5`, thinking off, `effort: low`, structured output pinned to a JSON schema |
| Stylist | same model and settings, system prompt carries the in-stock shelf + brand voice |

Both calls have a 15s timeout and one retry. Change the model in `wrangler.toml`
(`ANTHROPIC_MODEL`) — `claude-opus-5` is the stronger option if ranking quality matters more than
latency.

### Running without Claude

The bot works with `ANTHROPIC_API_KEY` unset. Ranking falls back to a deterministic sort (widest
size availability first, then price) with templated reasons; the stylist replies with a fixed
prompt for more detail. The same fallback catches API errors, timeouts and refusals, so a Claude
outage degrades the bot instead of breaking it.

## Brand copy

The rules are enforced **in code, not by another model call**:

- Every user-facing string is hardcoded in the `COPY` block and written to the rules.
- Anything Claude writes is checked by `copyViolations()` before it is sent. A bad ranking reason
  is swapped for the deterministic one; a bad stylist reply is regenerated once with the specific
  violations quoted back, then falls back to fixed copy.
- INR is formatted by `formatINR()` with Indian digit grouping (`₹2,499`, `₹1,25,000`) rather than
  `toLocaleString`, so it does not depend on the runtime's ICU data.

Banned: *should, need, pulled-together, effortless, great, best, lovely choice, fluid*. No sentence
starts with *With*, *And*, or *Here*.

### Wording that differs from the spec

Three labels in the spec break its own copy rules or WhatsApp's limits:

| Spec | Shipped | Why |
| --- | --- | --- |
| "Here are 3 looks…" | "3 looks, curated for you:" | flagged in the spec itself |
| "Need something specific" / "Need help with size/fit" | "Something specific" / "Size & fit help" | *need* is a banned word |
| "Show More Looks Again" | "Show More Looks" | reply-button titles cap at 20 characters |

Two more implementation notes: the ranking schema returns `{ "picks": [{ id, oneLineReason }] }`
rather than a bare array, because a structured-output schema needs an object at the root; and
because a Worker cannot observe the shopper returning from GoKwik, checkout is followed by an
**Order Placed** button (any typed message at that step works too) which triggers the simulated
confirmation.

## Assumptions

- The shopper messages first, so the 24-hour service window is open and no message templates are
  needed. Re-engaging outside that window would need an approved template.
- The webhook returns `200` immediately and does the work in `ctx.waitUntil()`. No request
  signature check — add `X-Hub-Signature-256` HMAC verification against the app secret before this
  goes anywhere near production.
- **Browse Same Category** pages the whole category in stock, not filtered by occasion, matching
  the spec's "all in-stock products in the current category".

## Local checks

```sh
npm run typecheck   # tsc --noEmit
npm run build       # wrangler deploy --dry-run
```
