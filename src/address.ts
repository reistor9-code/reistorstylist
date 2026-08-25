/**
 * Shipping address, collected inside the chat.
 *
 * WhatsApp has a native address form for India and Singapore — an interactive
 * message of type `address_message` — and it is the only way to get a delivery
 * address without sending the shopper to a web page. Meta renders the form,
 * validates the PIN code, and hands back structured fields.
 *
 * This is the half of in-chat checkout that needs no entitlement. Payments are
 * gated behind an India Payments API approval this business does not have;
 * the address form is not, so the address can be captured today and the money
 * taken by whatever checkout is configured.
 *
 * What it fixes: every order the bot has created carries an `address-pending`
 * tag and a note telling staff to chase the customer, because a Razorpay
 * payment link cannot collect one. With this, the order arrives fulfillable.
 *
 * ---------------------------------------------------------------------------
 * The submitted-address webhook shape is not published in Meta's Cloud API
 * reference, so the reply is read defensively and the raw body is logged. The
 * outgoing payload IS documented and is followed exactly.
 * ---------------------------------------------------------------------------
 */

import type { Env, State } from './types';
import { graph } from './whatsapp';

const SAVED_TTL_SECONDS = 60 * 60 * 24 * 180;
const savedKey = (waId: string) => `addr:${waId}`;

/**
 * The India field set, exactly as Meta names it.
 *
 * `in_pin_code` is the PIN code — Meta validates it and can return a
 * validation_errors object naming the field that failed, which is why the
 * names have to match rather than being tidied into our own shape.
 */
export interface ShippingAddress {
  name?: string;
  phone_number?: string;
  /**
   * The PIN code. Meta's own field is `in_pin_code` — third-party guides say
   * `in_post_code`, which is wrong and cost us a loop: the value never landed,
   * so the address read as incomplete and the form was sent again.
   */
  in_pin_code?: string;
  house_number?: string;
  floor_number?: string;
  tower_number?: string;
  building_name?: string;
  address?: string;
  landmark_area?: string;
  city?: string;
  state?: string;
}

/** Enough to ship to. Meta can return a partial form. */
export function isComplete(a: ShippingAddress | null | undefined): a is ShippingAddress {
  return Boolean(a?.address && a.city && a.in_pin_code);
}

export async function loadAddress(env: Env, waId: string): Promise<ShippingAddress | null> {
  const raw = await env.STATE.get(savedKey(waId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ShippingAddress;
  } catch {
    return null;
  }
}

/**
 * Kept for six months, so a returning shopper confirms rather than retypes.
 *
 * Meta's form takes `saved_addresses` and renders them as pickable options —
 * which is the whole reason to store it. Nothing here is sent anywhere except
 * back to the same shopper and onto their own Shopify order.
 */
export async function saveAddress(
  env: Env,
  waId: string,
  address: ShippingAddress,
): Promise<void> {
  await env.STATE.put(savedKey(waId), JSON.stringify(address), {
    expirationTtl: SAVED_TTL_SECONDS,
  });
}

/**
 * Asks for the address.
 *
 * Returns false when Meta rejects the send — the message type is India and
 * Singapore only, and may carry the same commerce entitlement payments do —
 * so the caller can carry on to checkout rather than stranding a shopper who
 * has already chosen their size.
 */
export async function askAddress(
  env: Env,
  to: string,
  state: State,
  body: string,
): Promise<boolean> {
  const saved = await loadAddress(env, to);

  const sent = await graph(env, {
    to,
    type: 'interactive',
    interactive: {
      type: 'address_message',
      body: { text: body },
      action: {
        name: 'address_message',
        parameters: {
          country: 'IN',
          /*
           * A saved address is offered as a pickable option rather than a
           * prefill. Prefilling `values` puts the old address in the form
           * whether or not it is still right; `saved_addresses` lets the
           * shopper confirm it or start clean, which is what a returning
           * customer actually wants.
           */
          ...(saved
            ? { saved_addresses: [{ id: 'last', value: { ...saved, phone_number: dialable(to) } }] }
            : { values: { phone_number: dialable(to) } }),
        },
      },
    },
  });

  if (!sent) {
    console.log('[address:rejected]', to, '— address_message unavailable');
    return false;
  }

  state.step = 'address';
  console.log('[address:asked]', to, saved ? 'with a saved address' : 'blank');
  return true;
}

/** WhatsApp ids are `91XXXXXXXXXX`; the form wants a dialable number. */
const dialable = (waId: string) => `+${waId.replace(/\D/g, '')}`;

/**
 * Reads a submitted address out of an inbound interactive message.
 *
 * Meta returns these as an `nfm_reply` carrying a JSON string, the same
 * envelope Flows use. The inner shape is not documented for address messages,
 * so the fields are looked for at both the top level and under the wrappers
 * they plausibly arrive in.
 */
export function parseAddressReply(message: Record<string, any>): ShippingAddress | null {
  const interactive = message?.interactive ?? message;
  const reply = interactive?.nfm_reply ?? interactive?.address_message_reply;
  if (!reply) return null;

  let payload: any = reply.response_json ?? reply.body ?? reply;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      console.log('[address:unparseable]', String(payload).slice(0, 300));
      return null;
    }
  }

  const v = payload?.values ?? payload?.address ?? payload?.selected_address ?? payload;
  if (!v || typeof v !== 'object') return null;

  const address: ShippingAddress = {
    name: str(v.name),
    phone_number: str(v.phone_number),
    in_pin_code: str(
      v.in_pin_code ?? v.in_post_code ?? v.postal_code ?? v.pin_code ?? v.pincode ?? v.zip,
    ),
    house_number: str(v.house_number),
    floor_number: str(v.floor_number),
    tower_number: str(v.tower_number),
    building_name: str(v.building_name),
    address: str(v.address ?? v.address_line_1 ?? v.street),
    landmark_area: str(v.landmark_area ?? v.landmark),
    city: str(v.city),
    state: str(v.state),
  };

  // An empty object is not an address — it means the shape was wrong.
  return Object.values(address).some(Boolean) ? address : null;
}

const str = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s || undefined;
};

/**
 * Meta's fields, flattened into Shopify's mailing address.
 *
 * Shopify has two address lines and no concept of a tower or a floor, so the
 * parts that describe where in a building someone lives are joined into the
 * second line rather than dropped — a courier in Mumbai needs the floor far
 * more than Shopify needs a tidy schema.
 */
export function toShopifyAddress(a: ShippingAddress, fallbackPhone: string): Record<string, unknown> {
  const [first, ...rest] = (a.name ?? '').split(/\s+/).filter(Boolean);

  const line2 = [a.building_name, a.tower_number && `Tower ${a.tower_number}`, a.floor_number && `Floor ${a.floor_number}`, a.landmark_area]
    .filter(Boolean)
    .join(', ');

  return {
    ...(first ? { firstName: first } : {}),
    ...(rest.length ? { lastName: rest.join(' ') } : {}),
    address1: [a.house_number, a.address].filter(Boolean).join(', ') || a.address,
    ...(line2 ? { address2: line2 } : {}),
    city: a.city,
    ...(a.state ? { provinceCode: undefined, province: a.state } : {}),
    zip: a.in_pin_code,
    countryCode: 'IN',
    phone: a.phone_number || fallbackPhone,
  };
}

/** One line for a chat message, so the shopper can check it before paying. */
export function summarise(a: ShippingAddress): string {
  return [
    a.name,
    [a.house_number, a.address].filter(Boolean).join(', '),
    [a.building_name, a.landmark_area].filter(Boolean).join(', '),
    [a.city, a.state, a.in_pin_code].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join('\n');
}
