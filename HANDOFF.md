# Handoff — wire these 30 products into the Reistor WhatsApp bot

Paste this file's path to Claude in VS Code, or paste the brief below.

---

## Brief

Wire the products in this folder into the bot's test path, so every screen runs
on real Reistor data instead of placeholders.

**Read `products.json`.** Thirty products, five in each of the six categories
the bot offers: Jackets, Tops, Bottoms, Dresses, Jumpsuits, Co-ord Sets.

**Use `retailer_id` as the join key everywhere.** It is what a Product Card
Carousel sends back as `product_retailer_id`, and what WhatsApp's native product
view looks up. If it drifts between Shopify, the Meta catalog and the bot, the
card opens nothing.

**Two image fields, two jobs:**

| Field | Use it for |
|---|---|
| `local_image` | Tests, offline demos, anything rendering from disk |
| `image_link` | The Meta catalog feed — Meta fetches the URL, it does not accept uploads |

Do not swap them. A local path in a catalog feed fails silently at import.

---

## What to build

1. **Load `products.json`** into whatever the bot uses as its product source.
   `products.js` is the same data as an ES module with `PRODUCTS`,
   `BY_CATEGORY`, `CATEGORIES` and `findByRetailerId()` if that is easier to
   import.

2. **Category menu** — six rows, one per category, each showing how many
   products are in stock. This is an **Interactive List**, not a carousel: no
   images, no template, no Meta approval. Row title caps at 24 characters and
   the description at 72; every label here is inside both.

3. **Round** — three products from the chosen category as a **Product Card
   Carousel**. Card image is `image_link`. Put `retailer_id` on every card.
   **Do not add buttons to product cards** — Meta rejects them, and the card is
   already the tap target.

4. **Product view** — when a card is tapped, send a **Single-Product Message**
   for that `retailer_id`. WhatsApp draws the detail page itself from the
   catalog. Do not hand-build a gallery; `additional_image_link` is what fills
   it, and there are 241 additional images across these 30.

5. **Size** — the catalog holds one item per style, not one per size, so the
   native page has nowhere to ask. Send a **WhatsApp Flow** after Add to cart,
   with `sizes_in_stock` as the options. Show sold-out sizes disabled rather
   than hidden, and never preselect one.

---

## Constraints worth having in front of you

| Thing | Limit |
|---|---|
| Carousel cards | 2 minimum, 10 maximum |
| Buttons on a product card | **zero** — not allowed |
| Interactive list rows | 10 across up to 10 sections |
| List row title / description | 24 / 72 characters |
| List button label | 20 characters |
| Template button label | 25 characters |
| Quick reply buttons, interactive message | 3 |
| Catalog media per item | 1 `image_link` + up to 20 `additional_image_link` + up to 20 `video[n].url` |
| Messages to one person | 1 every 6 seconds sustained, burst up to 45 in 6s, else error 131056 |

---

## Do not do these

- **Do not make a plain image or a media card tappable.** Only a product card
  carries `product_retailer_id`, and that id is the only thing that makes a
  picture open anything. Everywhere else the selector must be a button, a list
  row, or a Flow CTA.
- **Do not put lifestyle or mood images in the catalog.** Meta requires a
  listing image to represent the exact product for sale. Use each product's own
  photography — which is what every file in this folder is.
- **Do not send anything outside the 24-hour window without an approved
  template.** Nudges and coupons are templates; everything in the browse flow is
  free-form and needs no approval.

---

## Files

| File | What it is |
|---|---|
| `products.json` | The 30 products, flat array, ready to load |
| `products.js` | Same data as an ES module with helpers |
| `manifest.json` | Fuller records including Shopify handle and image counts |
| `catalog-feed.csv` | Meta catalog feed columns — upload to Commerce Manager |
| `<category>/NN-*.jpg` | Hero image per product |
| `README.md` | Where the data came from |

---

## How to check it worked

- Every category returns 5 products.
- Every `retailer_id` in `products.json` resolves through `findByRetailerId()`.
- No product card renders a button.
- Tapping a card sends a Single-Product Message carrying the right
  `retailer_id`.
- The size Flow lists only `sizes_in_stock`, and nothing sold out is
  preselected.
- No round shows the same image twice.
