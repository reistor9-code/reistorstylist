# Reistor WhatsApp Stylist Bot

DIY architecture specification — internal engineering reference

# 1\. Purpose

This document lays out a fully self-built (DIY) architecture for the WhatsApp AI stylist flow: category selection, product browsing, size/stock check, in-chat payment, Shopify order sync, and full conversation capture for analytics. It is the engineering reference for scoping and building this end to end, in-house.

Everything below has been checked against Meta's current WhatsApp Business Platform documentation and is technically buildable by a capable web development team. Section 5 gives a calibrated view of realistic timeline and known friction points — not blockers, but things worth planning for rather than discovering mid-build.

# 2\. Two systems that are commonly confused

Carousel Templates and the Facebook/Meta Commerce Catalog are separate Meta products. Neither requires the other. This distinction is the root of most of the back-and-forth so far.

|  | Carousel Template | Facebook Commerce Catalog |
| :---- | :---- | :---- |
| Lives in | WhatsApp Manager → Message Templates | Meta Commerce Manager |
| What it is | A reusable message shape (card count, buttons) | A synced product feed |
| Needs Shopify sync? | No | Yes |
| Used for | Our category and product carousels | Not used in this proposal |

# 3\. End-to-end flow

## 3.1 Category selection

* Customer messages the bot → we send Carousel Template \#1: Top / Bottom / Jacket.

* These 3 images are near-static (category photos, not specific products) — no live Shopify call needed here.

* Each card has one quick-reply button, payload e.g. cat\_top.

## 3.2 Product selection

* Customer taps “Top” → Meta sends our backend a webhook with the button payload.

* Our backend queries Shopify live (Admin/Storefront API) for the current Tops collection.

* Backend sends Carousel Template \#2, populated at send-time with fresh Shopify images and product IDs (see Section 6 for the exact fetch).

* Customer taps a specific product → webhook fires with that product ID.

## 3.3 Size and stock check

* This step uses a WhatsApp Flow, not a Carousel Template — Flows can run live logic; Templates cannot.

* The Flow calls our backend in real time; backend queries Shopify for that product’s variants and current stock; Flow renders only in-stock sizes.

## 3.4 Payment

* India (reistor.in): Meta’s India Payments API with Razorpay as the configured gateway — genuine in-chat checkout.

* International (reistor.com): a Razorpay/Stripe payment link sent as a message — customer completes checkout on a hosted page.

* Payment status webhook is not trusted alone — backend independently calls the gateway’s lookup API to confirm before fulfilling.

## 3.5 Shopify order sync

* On confirmed payment, backend calls Shopify’s Admin API to create the order — this decrements real inventory and triggers fulfillment.

* Confirmation message sent back to the customer.

# 4\. What needs to be built, and by whom

| Component | Owner if DIY | Notes |
| :---- | :---- | :---- |
| Carousel Template \#1 (category) | Us — one-time setup | Static images, no Shopify needed |
| Carousel Template \#2 (products) | Us — one-time setup \+ backend | Backend populates fresh from Shopify every send |
| Backend state machine | Us | Tracks each customer’s step; WhatsApp itself holds no state |
| WhatsApp Flow \+ data-exchange endpoint | Us | Encrypted request/response per Meta spec; this is where live stock logic lives |
| Payment integration | Us | India Payments API \+ Razorpay (India); payment links (international) |
| Shopify order write-back | Us | Not automatic — must be built regardless of who owns messaging |
| Human agent inbox | Meta’s free WhatsApp Manager inbox, or built later | Basic inbox exists for free; not required to build from scratch |

# 5\. Feasibility: is this achievable, and what could actually slow it down

Yes — every piece in this document is buildable with a capable in-house web development team, using only current, documented Meta and Shopify APIs. There is no step here that requires special access we cannot get as a standard business. That said, “completely achievable” and “no hurdles” are two different claims — the honest picture is: no hard technical blocker, but several known friction points worth planning for up front so they do not surprise the team mid-build.

* Meta Business verification and WABA setup has its own approval timeline, typically days, occasionally longer if documentation is queried — this sits on the critical path before any template can be submitted.

* Template approval (both carousels) is not guaranteed on first submission — Meta can reject on policy or formatting grounds. Budget for at least one revision cycle per template, not zero.

* WhatsApp Flow encryption is the most failure-prone new piece for a team that has not built one before. This is a well-documented class of bug — for example, one popular open-source WhatsApp inbox project had a confirmed, shipped bug where Flow submission data arrived as null because the response payload was parsed incorrectly. Budget real testing time here specifically, not just “read the docs and implement.”

* New WhatsApp numbers start on a limited messaging tier (capped unique customers contactable per 24 hours) and scale up based on quality rating over time — relevant if the stylist bot launches to a large existing customer base on day one rather than ramping up.

* India Payments API access requires its own Meta approval step, separate from general WABA approval — start this in parallel with the build, not after.

None of these change the answer to your question — yes, this is achievable — but a realistic internal timeline should be measured in weeks, with approval steps run in parallel to development, not treated as instant.

# 6\. Image specs and product image source

## 6.1 Carousel image specs (confirmed against current WhatsApp documentation)

* Max file size: 5MB per image, JPG or PNG.

* All cards within one carousel must share the same aspect ratio — no mixing.

* Recommended: portrait 4:3 (1200×1600px) for product-focused cards (Tops/Bottoms/Jackets carousel).

* Landscape 16:9 (1600×900px) or square is acceptable for more generic/category visuals.

* Recommendation: use portrait 4:3 consistently across both carousels for visual consistency.

## 6.2 Sourcing product images from a dedicated Shopify metafield

Rather than pulling from the main product gallery (which is designed for the website, not a 4:3 chat card), define a Shopify metafield of type file\_reference — e.g. custom.whatsapp\_carousel\_image — and upload a purpose-cropped image there per product. The backend fetches specifically this field.

**Shopify Admin GraphQL query:**

query GetCarouselImage($id: ID\!) {

  product(id: $id) {

    title

    metafield(namespace: "custom", key: "whatsapp\_carousel\_image") {

      reference {

        ... on MediaImage { image { url } }

      }

    }

  }

}

**WhatsApp send-time parameter (per card), referencing that URL directly:**

{

  "type": "header",

  "parameters": \[{ "type": "image", "image": { "link": "\<metafield image URL\>" } }\]

}

Meta fetches the hosted URL directly at send time — no separate media upload step is required for this approach.

# 7\. Open items before build starts

* Confirm the build sequence — recommended order is: WABA setup and verification, category and product carousel templates, backend state machine, WhatsApp Flow with encrypted data exchange, payment integration, then the conversation database in Section 8\.

* Define the product-set logic per category (collections vs tags) in Shopify.

* Set up the custom.whatsapp\_carousel\_image metafield and populate it for at least the first launch category.

* Scope and budget the WhatsApp Flow encryption implementation — this is the most unfamiliar piece for a team new to the WhatsApp Business Platform.

* Confirm India Payments API access and Razorpay configuration timeline directly with Meta, since this approval step sits outside our own build timeline.

# 8\. Capturing the complete conversation for the analytics database

This section covers how every message — bot-sent, customer-sent, and human-agent-sent — gets captured into a structured database for the dashboard, and how human handoff works. This is a later-phase concern, built on top of the flow in Sections 3–7.

## 8.1 There is no “handoff API” — it is application logic

WhatsApp cannot distinguish a message sent by bot code from one typed by a human agent — both go through the identical send-message call. “Handoff” is entirely our own logic:

* Backend detects intent (a button payload, or recognized free text) requesting a human.

* Backend flags that customer as needs\_human and pauses automated replies to that number.

* A human sees the conversation and replies through the same API, via an inbox UI.

* Meta provides a basic manual-reply view in WhatsApp Manager, but it is not built for team workflows (no assignment, no canned responses). A real multi-agent inbox with attachments and routing is something we build or source separately — treat this as a distinct, non-trivial component, not a byproduct of the Cloud API.

* File attachments: agents can send media via the API like any message. For files a customer sends us, the webhook only contains a media\_id — we must call a separate endpoint for a temporary download URL and store the file ourselves promptly, since Meta does not retain it long-term.

## 8.2 Webhook structure — confirmed against current Meta documentation

One webhook URL is configured for the whole WhatsApp Business Account. It delivers two distinct event types, distinguished by a field value:

Inbound customer message (field: "messages"):

{ "from": "919591372362",   // always the full, unmasked phone number

  "id": "wamid.HBg...",     // unique ID for this message

  "timestamp": "...", "type": "text" | "interactive" | "image" | "order" | ...,

  "context": { "id": "wamid.PRIOR..." } }  // present only if replying to a specific message

Delivery status of our outbound message (field: "statuses"):

{ "id": "wamid.HBg...",           // matches the wamid from our send call

  "recipient\_id": "919591372362",

  "status": "sent" | "delivered" | "read" | "failed", "timestamp": "..." }

Important operational note, checked against today’s date: Meta switched the Certificate Authority for webhook mTLS on March 31, 2026\. Whoever implements the webhook endpoint must confirm the current trust store is in use, or webhooks will silently stop arriving with no error visible to us.

## 8.3 Correlation keys — how everything threads into one conversation

* Phone number (E.164) is the primary key across all messages for a customer. Because this is a direct Cloud API integration rather than a third-party export, it arrives unmasked directly from Meta on every webhook — no decode step is needed.

* wamid (message ID) is the secondary key: our send call returns it immediately, and later status webhooks reference the same wamid to update sent/delivered/read/failed.

* context.id on an inbound message, when present, tells us explicitly which prior message the customer is replying to — useful for exact threading beyond simple chronological order.

## 8.4 Proposed data structure

messages

  wamid          PK

  phone\_e164     FK \-\> customers, always real/unmasked

  direction      "in" | "out"

  type           text | interactive | image | order | ...

  content        text body, or media\_id \+ locally-stored file path

  status         sent | delivered | read | failed

  context\_wamid  which prior message this replies to, if any

  flow\_step      our own tag: category\_selected, size\_check, agent\_handoff, etc

  timestamp

customers

  phone\_e164     PK

  name, first\_seen, last\_seen

  needs\_human    boolean, drives the handoff pause

  assigned\_agent

This is the same structure as the Customer\_Flow dashboard already built from historical export analysis — the difference is this version populates itself continuously from live webhooks instead of being rebuilt from a periodic file. Every customer’s full journey (welcome message, carousel selections, size check, payment or agent handoff, and any follow-up weeks later) becomes one continuous, timestamp-sorted record keyed to their phone number, feeding the same kind of dashboard and AI-driven drop-off analysis already in place.

## 8.5 Mapping the complete flow, not just messages — including when a customer selects nothing

Two things need deliberate design here; neither is automatic from Meta’s webhooks.

* Which step of our flow a message belongs to (category shown, product carousel shown, size check, payment attempted) is not something Meta tells us. The webhook only contains the raw button payload and message content. Our backend must tag every message with the current flow\_step at the moment it is sent or received — this is a design discipline the team must apply consistently at every state transition, not a field Meta populates for us.

* Customers who select nothing — true drop-off — do not generate any event at all. Checked directly against Meta's Flow documentation: a completion webhook fires only once the Flow closes with a submission; there is no separate webhook for a Flow that was opened and abandoned, or a carousel that was delivered and ignored.

* This means drop-off must be inferred, not received. The standard approach: when we send a step, record the timestamp and expected next action; run a scheduled job that checks for customers with no corresponding reply after a defined window (for example, 24 hours) and marks them dropped\_off\_at\_step accordingly. This is a small, buildable piece of infrastructure — but it is infrastructure we build, not a signal WhatsApp pushes to us.

* With both of these in place — explicit flow\_step tagging on every real event, plus timeout-based drop-off inference — the complete journey (including exactly where someone stopped) is fully mappable and queryable for the dashboard.