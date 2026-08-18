/**
 * WhatsApp Flow data-exchange endpoint.
 *
 * This is the piece the architecture spec correctly calls the most
 * failure-prone part of the build, so the protocol is spelled out here rather
 * than left implicit:
 *
 *   1. WhatsApp POSTs { encrypted_flow_data, encrypted_aes_key, initial_vector },
 *      all base64.
 *   2. `encrypted_aes_key` is an AES key sealed with our PUBLIC key. Unseal it
 *      with the private key using RSA-OAEP / SHA-256.
 *   3. `encrypted_flow_data` is AES-GCM under that key and `initial_vector`,
 *      with the 16-byte auth tag appended to the ciphertext — which is exactly
 *      the layout WebCrypto's decrypt expects, so no splitting is needed.
 *   4. The response is encrypted with the SAME AES key but an INVERTED IV
 *      (every byte XOR 0xFF), base64-encoded, and returned as a plain string
 *      body — not JSON, not an object. Returning JSON here is the single most
 *      common reason a Flow submits as null.
 *
 * Health checks arrive as action "ping" and must be answered, or the Flow will
 * not publish.
 */

import type { Env } from './env';
import { getProduct, type Product } from './catalog';

/* ------------------------------------------------------------------ *
 * base64 helpers — Workers have atob/btoa but not Buffer
 * ------------------------------------------------------------------ */

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  // Chunked so a large payload cannot blow the argument limit on spread.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/* ------------------------------------------------------------------ *
 * Key import
 * ------------------------------------------------------------------ */

/**
 * Imports the PKCS#8 PEM private key uploaded alongside its public half.
 *
 * Note this does NOT handle an encrypted private key — WebCrypto cannot import
 * one. Generate the pair without a passphrase, or decrypt it before storing it
 * as a secret.
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');

  if (!body) throw new Error('FLOW_PRIVATE_KEY is empty or not PEM');

  return crypto.subtle.importKey(
    'pkcs8',
    b64ToBytes(body),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  );
}

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

interface Envelope {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}

interface Decrypted {
  payload: FlowRequest;
  aesKey: CryptoKey;
  iv: Uint8Array;
}

export interface FlowRequest {
  version: string;
  action: 'ping' | 'INIT' | 'BACK' | 'data_exchange';
  screen?: string;
  data?: Record<string, unknown>;
  flow_token?: string;
}

async function decryptRequest(env: Env, body: Envelope): Promise<Decrypted> {
  if (!env.FLOW_PRIVATE_KEY) throw new Error('FLOW_PRIVATE_KEY is not configured');

  const privateKey = await importPrivateKey(env.FLOW_PRIVATE_KEY);

  const aesKeyBytes = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    b64ToBytes(body.encrypted_aes_key),
  );

  const aesKey = await crypto.subtle.importKey(
    'raw',
    aesKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt', 'encrypt'],
  );

  const iv = b64ToBytes(body.initial_vector);

  // The auth tag is the trailing 16 bytes of the ciphertext, which is what
  // WebCrypto assumes — hand it the whole buffer untouched.
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aesKey,
    b64ToBytes(body.encrypted_flow_data),
  );

  return {
    payload: JSON.parse(new TextDecoder().decode(plain)) as FlowRequest,
    aesKey,
    iv,
  };
}

/**
 * Encrypts the reply under the same key with the IV bit-flipped.
 *
 * Reusing the original IV would repeat a (key, IV) pair under GCM, which leaks
 * the keystream — hence the flip. Meta's client expects exactly this.
 */
async function encryptResponse(
  aesKey: CryptoKey,
  iv: Uint8Array,
  response: unknown,
): Promise<string> {
  const flipped = new Uint8Array(iv.length);
  for (let i = 0; i < iv.length; i++) flipped[i] = iv[i] ^ 0xff;

  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: flipped, tagLength: 128 },
    aesKey,
    new TextEncoder().encode(JSON.stringify(response)),
  );

  return bytesToB64(new Uint8Array(sealed));
}

/* ------------------------------------------------------------------ *
 * Screens
 * ------------------------------------------------------------------ */

const SIZE_SCREEN = 'SIZE_PICKER';

/**
 * Builds the size screen from live stock.
 *
 * Sold-out sizes are listed and disabled rather than hidden: a shopper who
 * cannot find their size assumes the brand does not make it, which is worse
 * than knowing it exists and sold out. Nothing sold out is ever preselected.
 */
function sizeScreenData(product: Product) {
  const inStock = product.sizes.filter((s) => s.stock > 0);

  return {
    screen: SIZE_SCREEN,
    data: {
      product_name: product.title,
      product_price: product.priceFormatted,
      sold_out: inStock.length === 0,
      note:
        inStock.length === 0
          ? 'Every size is sold out right now.'
          : `In stock: ${inStock.map((s) => s.size).join(', ')}`,
      sizes: product.sizes.map((s) => ({
        id: s.size,
        title: s.stock > 0 ? s.size : `${s.size} — sold out`,
        enabled: s.stock > 0,
      })),
      // A sold-out size must never arrive preselected.
      preselected: inStock.length ? inStock.find((s) => s.size === 'M')?.size ?? inStock[0].size : null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Request handling
 * ------------------------------------------------------------------ */

/**
 * What the Flow token carries. Encoding the sku in the token means the size
 * screen can be rebuilt from stock on every open without trusting anything the
 * client sends back.
 */
export interface FlowToken {
  waId: string;
  sku: string;
  issued: number;
}

export function encodeFlowToken(t: FlowToken): string {
  return `${t.waId}:${t.sku}:${t.issued}`;
}

export function decodeFlowToken(raw?: string): FlowToken | null {
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length < 3) return null;
  const issued = Number(parts[parts.length - 1]);
  if (!Number.isFinite(issued)) return null;
  return {
    waId: parts[0],
    sku: parts.slice(1, -1).join(':'),
    issued,
  };
}

/** Business logic, already decrypted. Kept separate so it is testable. */
async function respond(env: Env, req: FlowRequest): Promise<unknown> {
  // Health check. Must be answered or the Flow will not publish.
  if (req.action === 'ping') {
    return { data: { status: 'active' } };
  }

  // The client reports an error it hit; acknowledge and move on.
  if (req.data?.error) {
    console.log('[flow:client-error]', JSON.stringify(req.data));
    return { data: { acknowledged: true } };
  }

  const token = decodeFlowToken(req.flow_token);
  if (!token) {
    console.log('[flow:bad-token]', req.flow_token);
    return {
      screen: SIZE_SCREEN,
      data: { sold_out: true, note: 'This session expired. Message us again for a fresh link.', sizes: [] },
    };
  }

  const product = await getProduct(env, token.sku);
  if (!product) {
    console.log('[flow:unknown-sku]', token.sku);
    return {
      screen: SIZE_SCREEN,
      data: { sold_out: true, note: 'That piece is no longer listed.', sizes: [] },
    };
  }

  if (req.action === 'INIT' || req.action === 'BACK') {
    return sizeScreenData(product);
  }

  if (req.action === 'data_exchange') {
    const chosen = String(req.data?.size ?? '');
    const live = product.sizes.find((s) => s.size === chosen);

    // Stock can go in the seconds between the screen rendering and the tap.
    if (!live || live.stock <= 0) {
      console.log('[flow:size-gone]', token.sku, chosen);
      return sizeScreenData(product);
    }

    // Terminal response: hand control back to the thread. `extension_message_response`
    // is what closes the sheet and posts the result into the chat.
    return {
      screen: 'SUCCESS',
      data: {
        extension_message_response: {
          params: {
            flow_token: req.flow_token,
            sku: token.sku,
            size: chosen,
          },
        },
      },
    };
  }

  console.log('[flow:unknown-action]', req.action);
  return { data: { acknowledged: true } };
}

/**
 * The /flow endpoint.
 *
 * Status codes matter here. A 421 tells WhatsApp the key is wrong and makes it
 * re-fetch; anything else on a decryption failure leaves the client retrying
 * against a key that will never work.
 */
export async function handleFlow(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body: Envelope;
  try {
    body = (await request.json()) as Envelope;
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  if (!body?.encrypted_flow_data || !body?.encrypted_aes_key || !body?.initial_vector) {
    return new Response('Bad request', { status: 400 });
  }

  let decrypted: Decrypted;
  try {
    decrypted = await decryptRequest(env, body);
  } catch (err) {
    console.log('[flow:decrypt-error]', String(err));
    // 421 makes WhatsApp refresh the public key rather than retry blindly.
    return new Response('Failed to decrypt. Refresh the public key.', { status: 421 });
  }

  console.log('[flow:in]', JSON.stringify(decrypted.payload));

  try {
    const reply = await respond(env, decrypted.payload);
    console.log('[flow:out]', JSON.stringify(reply));
    const sealed = await encryptResponse(decrypted.aesKey, decrypted.iv, reply);
    // Plain base64 text. Sending JSON here is what makes submissions arrive null.
    return new Response(sealed, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  } catch (err) {
    console.log('[flow:error]', String(err), (err as Error)?.stack);
    return new Response('Internal error', { status: 500 });
  }
}
