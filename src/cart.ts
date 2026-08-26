/**
 * The basket, kept in its own KV record.
 *
 * It used to live on the flow state, and that lost baskets. Every inbound
 * message does load-state → modify → save-state, and WhatsApp delivers a sent
 * cart at the same moment as whatever the shopper last tapped. The two
 * invocations both read the state before either wrote, and the slower save
 * put back a copy with no basket in it — after which the next size tap found
 * nothing to size and checked out a single garment.
 *
 * A separate key cannot be clobbered by an unrelated state write. It is not
 * atomic — KV has no compare-and-set — but the only writers are the three
 * functions below, and they never run concurrently for one shopper the way
 * state writes do.
 */

import type { CartLine, Env } from './types';

const CART_TTL_SECONDS = 60 * 60 * 24;
const cartKey = (waId: string) => `cart:${waId}`;

export async function loadCart(env: Env, waId: string): Promise<CartLine[]> {
  const raw = await env.STATE.get(cartKey(waId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as CartLine[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveCart(env: Env, waId: string, lines: CartLine[]): Promise<void> {
  if (!lines.length) return clearCart(env, waId);
  await env.STATE.put(cartKey(waId), JSON.stringify(lines), {
    expirationTtl: CART_TTL_SECONDS,
  });
}

/** Called at checkout and on any full restart — Main Menu, End Chat, a greeting. */
export async function clearCart(env: Env, waId: string): Promise<void> {
  await Promise.all([
    env.STATE.delete(cartKey(waId)),
    /*
     * The two parked copies of the same basket go with it.
     *
     * Checkout asks three questions — address, then a discount code, then how
     * to pay — and parks the lines under `colines` across each one, because a
     * shopper answering a question is not sending a cart. `cod` is the same
     * basket again, held between the Confirm Order card and the tap on it.
     *
     * Left behind, they outlive the order that consumed them: a shopper who
     * paid and then hit an old Pay online button would be handed a payment
     * card for a basket they already bought. Clearing them here means the
     * basket dies in one place, whichever route the order took.
     */
    env.STATE.delete(`colines:${waId}`),
    env.STATE.delete(`cod:${waId}`),
  ]);
}
