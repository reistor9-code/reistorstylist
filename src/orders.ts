/**
 * Order tracking.
 *
 * Every route in here is free. The shopper's own message — "Track Order", or
 * "where is my order" typed out — opens a 24-hour service window, so the
 * reply is free-form and costs nothing. That is why tracking is answered on
 * request rather than pushed: a pushed update outside the window is a charged
 * Utility template, and five of them per order adds up quickly.
 */

import type { Env } from './types';
import { toShopifyAddress, type ShippingAddress } from './address';
import { toOrderDiscount, type Coupon } from './coupons';
import { getProducts, shopifyFetch, shopifyGraphql } from './catalog';
import { formatINR } from './copy';
import { LIMITS, sendButtons, sendList, sendText } from './whatsapp';

interface ShopifyOrderLine {
  title?: string;
  variant_title?: string;
  quantity?: number;
}

interface ShopifyOrder {
  id: number;
  name: string;
  created_at: string;
  total_price?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  line_items?: ShopifyOrderLine[];
  fulfillments?: { tracking_number?: string; tracking_url?: string; status?: string }[];
}

const COPY = {
  none: 'No orders on this number yet. Tap below to start a look.',
  lookupFailed: 'Order status is unavailable right now. Try again in a moment.',
  pick: 'Which order would you like an update on?',
  pickHeader: 'Your orders',
} as const;

/**
 * Shopify has no "search orders by phone" endpoint, so the recent order list
 * is pulled and matched locally. `any` status is required — the default is
 * open only, which hides everything already fulfilled.
 */
export async function findOrdersByPhone(env: Env, waId: string): Promise<ShopifyOrder[]> {
  const res = await shopifyFetch(
    env,
    'orders.json?status=any&limit=50&fields=id,name,created_at,total_price,financial_status,fulfillment_status,line_items,phone,customer,shipping_address,fulfillments',
  );
  if (!res.ok) {
    console.log('[orders:lookup-failed]', res.status);
    return [];
  }

  const body = (await res.json()) as { orders?: (ShopifyOrder & Record<string, any>)[] };
  const digits = waId.replace(/\D/g, '').slice(-10);

  return (body.orders ?? []).filter((order) => {
    const candidates = [
      order.phone,
      order.customer?.phone,
      order.shipping_address?.phone,
      order.billing_address?.phone,
    ];
    return candidates.some((p) => typeof p === 'string' && p.replace(/\D/g, '').endsWith(digits));
  });
}

/** Plain-language status, since Shopify's own wording is for merchants. */
function describe(order: ShopifyOrder): string {
  const tracking = order.fulfillments?.find((f) => f.tracking_number);
  const item = order.line_items?.[0];
  const line = item
    ? `${item.title}${item.variant_title ? ` · size ${item.variant_title}` : ''}`
    : 'Your order';

  const status = order.fulfillment_status === 'fulfilled'
    ? tracking?.tracking_number
      ? `On its way. Tracking ${tracking.tracking_number}.`
      : 'On its way.'
    : order.financial_status === 'paid'
      ? 'Paid and being packed.'
      : 'Payment pending.';

  const amount = order.total_price ? ` — ${formatINR(Number(order.total_price))}` : '';
  return `${order.name}${amount}\n${line}\n${status}${
    tracking?.tracking_url ? `\n${tracking.tracking_url}` : ''
  }`;
}

/**
 * Answers "where is my order", however it was asked.
 *
 * One order gets a straight answer; several get a list to pick from, because
 * guessing which one they meant is how you tell someone the wrong thing.
 */
export async function sendOrderStatus(env: Env, to: string): Promise<void> {
  let orders: ShopifyOrder[];
  try {
    orders = await findOrdersByPhone(env, to);
  } catch (err) {
    console.log('[orders:error]', String(err));
    await sendText(env, to, COPY.lookupFailed);
    return;
  }

  if (orders.length === 0) {
    await sendButtons(env, to, COPY.none, [{ id: 'act:main_menu', title: 'Main Menu' }]);
    return;
  }

  if (orders.length === 1) {
    await sendButtons(env, to, describe(orders[0]), [
      { id: 'act:again', title: 'Browse Again' },
      { id: 'act:end', title: 'End Chat' },
    ]);
    return;
  }

  await sendList(env, to, {
    header: COPY.pickHeader,
    body: COPY.pick,
    button: 'Pick order',
    rows: orders.slice(0, LIMITS.maxRows).map((order) => ({
      id: `order:${order.id}`,
      title: order.name,
      description: `${order.total_price ? formatINR(Number(order.total_price)) : ''} · ${
        order.fulfillment_status === 'fulfilled' ? 'On its way' : 'Being packed'
      }`,
    })),
  });
}

/** One order from the picker above. */
export async function sendSingleOrderStatus(env: Env, to: string, orderId: string): Promise<void> {
  const orders = await findOrdersByPhone(env, to);
  const order = orders.find((o) => String(o.id) === orderId);

  if (!order) {
    await sendText(env, to, COPY.lookupFailed);
    return;
  }

  await sendButtons(env, to, describe(order), [
    { id: 'act:again', title: 'Browse Again' },
    { id: 'act:end', title: 'End Chat' },
  ]);
}

/** Typed questions that mean "where is my order". */
export const TRACKING_QUESTION =
  /\b(where\s+is\s+my\s+order|track(ing)?\s+(my\s+)?order|order\s+status|my\s+order|delivery\s+status|shipped)\b/i;

/* ------------------------------------------------------------------ *
 * Order creation — a paid WhatsApp checkout, pushed into Shopify
 * ------------------------------------------------------------------ */

export interface OrderLine {
  productId: string;
  title: string;
  size: string;
  priceINR: number;
}

export interface OrderPushInput {
  /** Collected in the chat with an address_message. See src/address.ts. */
  shipping?: ShippingAddress;
  /** Validated against Shopify, so the order and the gateway agree. */
  coupon?: Coupon;
  /**
   * Cash on delivery — no money has moved.
   *
   * The order must not read as paid: the courier collects at the door, and an
   * order marked PAID with nothing behind it corrupts the day's takings and
   * tells the packer a debt has been settled that has not.
   */
  cod?: boolean;
  /**
   * The cash-on-delivery surcharge, in rupees.
   *
   * Carried onto the order as a shipping line so Shopify's own total matches
   * the figure the shopper agreed to in the chat. A fee shown on the card and
   * missing from the order is a courier collecting the wrong amount.
   */
  codFeeINR?: number;
  waId: string;
  sessionId: string;
  /** Every garment in the basket. One order, however many lines. */
  lines: OrderLine[];
  /** The total actually charged, which is what the transaction records. */
  amountINR: number;
  /** Razorpay's own ids, kept on the order so the two reconcile. */
  paymentId?: string;
  paymentLinkId?: string;
  email?: string;
  contact?: string;
  customerName?: string;
  /** Razorpay in test mode — tag it and keep stock and receipts untouched. */
  test?: boolean;
}

export interface OrderPushResult {
  ok: boolean;
  /** Shopify's own order number, e.g. "#1042" — what the shopper is told. */
  orderName?: string;
  orderId?: string;
  error?: string;
}

const ORDER_CREATE = `
  mutation CreateOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      userErrors { field message }
      order { id name }
    }
  }
`;

/**
 * Creates the Shopify order behind a paid WhatsApp checkout.
 *
 * No shipping address is sent. Razorpay's standard Payment Links cannot
 * collect one — the create-link API's `customer` object takes name, contact
 * and email and nothing else — so the order carries an `address-pending` tag
 * and the address is chased separately. Everything needed to reconcile is on
 * the order: the variant, the money, and both Razorpay ids.
 *
 * Requires `write_orders` on the Shopify app. Without it Shopify answers with
 * an access error, which is returned rather than thrown: the caller has
 * already taken the shopper's money and must not fail the webhook over this.
 */
export async function createShopifyOrder(
  env: Env,
  input: OrderPushInput,
): Promise<OrderPushResult> {
  const amount = input.amountINR.toFixed(2);
  const priceSet = { shopMoney: { amount, currencyCode: 'INR' } };

  /*
   * Variant ids are numeric in the catalog (the cart permalink needs them
   * that way), so they are widened to a gid here. Without one the line item
   * still carries the title and the money — an unlinked line is worse than a
   * linked one, but far better than losing a paid order.
   */
  const products = await getProducts(env);

  const lineItems = input.lines.map((line) => {
    const variantId = products
      .find((p) => p.id === line.productId)
      ?.sizes.find((s) => s.size === line.size)?.variantId;

    if (!variantId) console.log('[shopify:order-no-variant]', line.productId, line.size);

    // Each line carries its OWN price. Using the basket total on every line
    // would multiply the order by the number of garments in it.
    const linePrice = { shopMoney: { amount: line.priceINR.toFixed(2), currencyCode: 'INR' } };

    return variantId
      ? {
          variantId: `gid://shopify/ProductVariant/${variantId}`,
          quantity: 1,
          priceSet: linePrice,
          properties: [{ name: 'Size', value: line.size }],
        }
      : {
          title: `${line.title} — size ${line.size}`,
          quantity: 1,
          priceSet: linePrice,
          requiresShipping: true,
          properties: [{ name: 'Size', value: line.size }],
        };
  });

  /*
   * `address-pending` only when there genuinely is none. It is what the
   * fulfilment team filters on, so tagging an order that has a full address
   * would send someone chasing a customer who already gave it.
   */
  const hasAddress = Boolean(input.shipping?.address && input.shipping?.city);
  const tags = [
    'whatsapp-bot',
    ...(input.cod ? ['cod'] : []),
    ...(hasAddress ? [] : ['address-pending']),
    ...(input.test ? ['test-order'] : []),
  ];

  const note = [
    input.cod
      ? 'Cash on delivery, confirmed on WhatsApp. Collect payment at the door.'
      : 'Paid on WhatsApp via a Razorpay payment link.',
    input.paymentId ? `Razorpay payment ${input.paymentId}.` : null,
    hasAddress
      ? 'Shipping address collected in the chat.'
      : 'Shipping address NOT collected. Follow up with the customer before fulfilling.',
    input.coupon ? `Discount code ${input.coupon.code} applied.` : null,
    input.codFeeINR && input.codFeeINR > 0
      ? `Includes a cash-on-delivery fee of Rs ${input.codFeeINR}.`
      : null,
    input.test ? 'TEST ORDER — created while Razorpay was in test mode. Safe to delete.' : null,
  ]
    .filter(Boolean)
    .join(' ');

  const order: Record<string, unknown> = {
    currency: 'INR',
    /*
     * PENDING for cash on delivery, and no transaction at all.
     *
     * PAID with a SALE transaction would tell Shopify money had arrived, which
     * would show up in the day's revenue, in payouts that never reconcile, and
     * on a packing slip saying nothing is owed. The courier collects it.
     */
    financialStatus: input.cod ? 'PENDING' : 'PAID',
    /*
     * The channel a merchant sees is the app's own name, not this.
     *
     * `sourceName` takes the handle of an order attribution definition
     * registered by a published sales channel app — `youtube`, or
     * `channel:amazon-us`. A custom app cannot register one, so an arbitrary
     * string here is ignored and Shopify shows the app's name instead.
     * Renaming the app is what changes the channel.
     *
     * `sourceIdentifier` is the field that does work: the order's id on the
     * originating platform, which is the number the shopper was quoted in the
     * chat. It makes an order findable from a WhatsApp conversation.
     */
    sourceIdentifier: input.sessionId,
    note,
    tags,
    phone: input.contact || `+${input.waId.replace(/\D/g, '')}`,
    ...(input.shipping
      ? { shippingAddress: toShopifyAddress(input.shipping, `+${input.waId.replace(/\D/g, '')}`) }
      : {}),
    /*
     * The same code the shopper was quoted, so Shopify computes the discount
     * itself rather than being handed a total it cannot explain. Verified
     * against OrderCreateOrderInput — this takes a typed object, not a string.
     */
    ...(input.coupon ? { discountCode: toOrderDiscount(input.coupon) } : {}),
    /*
     * The COD fee, as a shipping line.
     *
     * Shopify has no "surcharge" concept on orderCreate; a shipping line is
     * the field that adds money to an order without pretending to be a
     * garment. As its own line it stays visible on the invoice and in reports,
     * rather than being buried by inflating a product price — and it is
     * refunded separately if the parcel comes back.
     */
    ...(input.codFeeINR && input.codFeeINR > 0
      ? {
          shippingLines: [
            {
              title: 'Cash on delivery fee',
              priceSet: {
                shopMoney: { amount: input.codFeeINR.toFixed(2), currencyCode: 'INR' },
              },
            },
          ],
        }
      : {}),
    lineItems,
    ...(input.cod
      ? {}
      : {
          transactions: [
            {
              kind: 'SALE',
              status: 'SUCCESS',
              gateway: 'razorpay',
              amountSet: priceSet,
            },
          ],
        }),
    customAttributes: [
      { key: 'WhatsApp number', value: input.waId },
      { key: 'Razorpay payment id', value: input.paymentId ?? 'unknown' },
      { key: 'Razorpay link id', value: input.paymentLinkId ?? 'unknown' },
      { key: 'Stylist session', value: input.sessionId },
    ],
    ...(input.email ? { email: input.email } : {}),
    ...(input.test ? { test: true } : {}),
  };

  const options = {
    // A test-mode payment must not move real stock.
    inventoryBehaviour: input.test ? 'BYPASS' : 'DECREMENT_OBEYING_POLICY',
    // The shopper is told in WhatsApp; a second email would only confuse.
    sendReceipt: false,
  };

  const res = await shopifyGraphql(env, ORDER_CREATE, { order, options });
  const payload = res.data?.orderCreate;
  const userErrors = payload?.userErrors ?? [];

  if (res.errors || userErrors.length || !payload?.order?.name) {
    const error = JSON.stringify(res.errors ?? userErrors ?? 'no order returned').slice(0, 400);
    console.log('[shopify:order-failed]', input.sessionId, res.status, error);
    return { ok: false, error };
  }

  console.log('[shopify:order-created]', input.sessionId, payload.order.name, payload.order.id);
  return { ok: true, orderName: payload.order.name, orderId: payload.order.id };
}
