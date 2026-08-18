/**
 * Meta webhook compliance.
 *
 * The fixtures below are the payload shapes documented in Meta's webhook
 * reference, not shapes invented to match the parser. That direction matters:
 * a test written from the implementation proves the code is self-consistent,
 * while one written from the specification proves it will survive contact with
 * Meta.
 *
 * Run: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { parseWebhook, batchIsEmpty } from '../dist/webhook/parse.js';
import { verifySignature, shouldProcess } from '../dist/webhook/signature.js';

const WABA = '102290129340398';
const PHONE_ID = '1221684564367817';
const SHOPPER = '919876543210';

const envelope = (field, value) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: WABA, changes: [{ field, value }] }],
});

const messagesValue = (extra) => ({
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '15551234567', phone_number_id: PHONE_ID },
  ...extra,
});

/* ------------------------------------------------------------------ *
 * Signature verification
 * ------------------------------------------------------------------ */

test('signature: a correct HMAC is accepted', async () => {
  const secret = 'app-secret';
  const body = JSON.stringify({ hello: 'world' });
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(await verifySignature(secret, sig, body), 'ok');
});

test('signature: a tampered body is rejected', async () => {
  const secret = 'app-secret';
  const body = JSON.stringify({ hello: 'world' });
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  // One trailing space is enough to change the digest.
  assert.equal(await verifySignature(secret, sig, body + ' '), 'bad-signature');
});

test('signature: a wrong secret is rejected', async () => {
  const body = '{}';
  const sig = 'sha256=' + createHmac('sha256', 'attacker').update(body).digest('hex');

  assert.equal(await verifySignature('real-secret', sig, body), 'bad-signature');
});

test('signature: a missing header is rejected, not ignored', async () => {
  assert.equal(await verifySignature('app-secret', null, '{}'), 'missing-signature');
});

test('signature: an unknown scheme is rejected', async () => {
  assert.equal(await verifySignature('app-secret', 'sha1=abc', '{}'), 'bad-signature');
});

test('signature: uppercase hex from Meta still matches', async () => {
  const secret = 'app-secret';
  const body = '{"a":1}';
  const hex = createHmac('sha256', secret).update(body).digest('hex').toUpperCase();

  assert.equal(await verifySignature(secret, `sha256=${hex}`, body), 'ok');
});

test('signature: unconfigured is allowed through but never counted as verified', async () => {
  const outcome = await verifySignature(undefined, null, '{}');
  assert.equal(outcome, 'not-configured');
  // Deliberate: shipping this check must not stop an existing deployment from
  // answering messages. It logs loudly instead.
  assert.equal(shouldProcess(outcome), true);
  assert.equal(shouldProcess('bad-signature'), false);
  assert.equal(shouldProcess('missing-signature'), false);
});

/* ------------------------------------------------------------------ *
 * Inbound messages
 * ------------------------------------------------------------------ */

test('parse: a text message, with the profile name from contacts', () => {
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({
        contacts: [{ profile: { name: 'Aditi' }, wa_id: SHOPPER }],
        messages: [
          {
            from: SHOPPER,
            id: 'wamid.TEXT1',
            timestamp: '1755500000',
            type: 'text',
            text: { body: 'hi' },
          },
        ],
      }),
    ),
  );

  assert.equal(batch.messages.length, 1);
  assert.equal(batch.messages[0].text, 'hi');
  assert.equal(batch.messages[0].waId, SHOPPER);
  // The name lives beside the message, not inside it.
  assert.equal(batch.messages[0].profileName, 'Aditi');
  assert.equal(batch.phoneNumberId, PHONE_ID);
});

test('parse: an interactive list reply carries its row id', () => {
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({
        messages: [
          {
            from: SHOPPER,
            id: 'wamid.LIST1',
            type: 'interactive',
            interactive: {
              type: 'list_reply',
              list_reply: { id: 'size:hemp-poplin-shirt:M', title: 'M' },
            },
          },
        ],
      }),
    ),
  );

  assert.equal(batch.messages[0].replyId, 'size:hemp-poplin-shirt:M');
});

test('parse: a template quick reply arrives under `button`, not `interactive`', () => {
  // Carousel card taps land here. Reading only `interactive` silently drops
  // every occasion and category answer.
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({
        messages: [
          {
            from: SHOPPER,
            id: 'wamid.BTN1',
            type: 'button',
            button: { payload: 'occ:work', text: 'Choose' },
          },
        ],
      }),
    ),
  );

  // The payload routes; the visible label does not.
  assert.equal(batch.messages[0].replyId, 'occ:work');
});

test('parse: a button with no payload falls back to its label', () => {
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({
        messages: [
          { from: SHOPPER, id: 'wamid.BTN2', type: 'button', button: { text: 'Order Placed' } },
        ],
      }),
    ),
  );

  assert.equal(batch.messages[0].text, 'Order Placed');
});

test('parse: a cart order yields its product items', () => {
  // The only webhook proving a shopper engaged with a product card.
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({
        messages: [
          {
            from: SHOPPER,
            id: 'wamid.ORDER1',
            type: 'order',
            order: {
              catalog_id: '1572339217700903',
              text: 'please confirm',
              product_items: [
                { product_retailer_id: 'RWTOBJASS2200963600S1', quantity: 2, item_price: 2999, currency: 'INR' },
              ],
            },
          },
        ],
      }),
    ),
  );

  const order = batch.messages[0].order;
  assert.ok(order);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].retailerId, 'RWTOBJASS2200963600S1');
  assert.equal(order.items[0].quantity, 2);
});

test('parse: an unsupported media type is kept but carries no routable text', () => {
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({
        messages: [{ from: SHOPPER, id: 'wamid.IMG1', type: 'image', image: { id: 'media-1' } }],
      }),
    ),
  );

  assert.equal(batch.messages.length, 1);
  assert.equal(batch.messages[0].messageType, 'image');
  assert.equal(batch.messages[0].text, undefined);
  assert.equal(batch.messages[0].replyId, undefined);
});

/* ------------------------------------------------------------------ *
 * Delivery statuses — where the cost data lives
 * ------------------------------------------------------------------ */

test('parse: a billable status carries its pricing category', () => {
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({
        statuses: [
          {
            id: 'wamid.OUT1',
            status: 'sent',
            timestamp: '1755500100',
            recipient_id: SHOPPER,
            pricing: { billable: true, pricing_model: 'PMP', category: 'marketing', type: 'regular' },
          },
        ],
      }),
    ),
  );

  assert.equal(batch.statuses.length, 1);
  assert.equal(batch.statuses[0].billable, true);
  assert.equal(batch.statuses[0].pricingCategory, 'marketing');
  assert.equal(batch.statuses[0].pricingType, 'regular');
  // Statuses ride the `messages` field — they are not a separate subscription.
  assert.equal(batch.messages.length, 0);
});

test('parse: a free customer-service status is recorded as not billable', () => {
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({
        statuses: [
          {
            id: 'wamid.OUT2',
            status: 'delivered',
            recipient_id: SHOPPER,
            pricing: { billable: false, pricing_model: 'PMP', type: 'free_customer_service', category: 'utility' },
          },
        ],
      }),
    ),
  );

  assert.equal(batch.statuses[0].billable, false);
  assert.equal(batch.statuses[0].pricingType, 'free_customer_service');
});

test('parse: a failed status keeps the error code', () => {
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({
        statuses: [
          {
            id: 'wamid.OUT3',
            status: 'failed',
            recipient_id: SHOPPER,
            errors: [{ code: 131050, title: 'User has opted out of marketing messages' }],
          },
        ],
      }),
    ),
  );

  assert.equal(batch.statuses[0].status, 'failed');
  assert.equal(batch.statuses[0].errorCode, 131050);
});

/* ------------------------------------------------------------------ *
 * Policy-relevant fields
 * ------------------------------------------------------------------ */

test('parse: a marketing opt-out is captured', () => {
  // Meta's policy requires honouring this. Missing it is the "you cannot claim
  // you did not know" exposure.
  const batch = parseWebhook(
    envelope('user_preferences', {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: PHONE_ID },
      contacts: [{ wa_id: SHOPPER, profile: { name: 'Aditi' } }],
      user_preferences: [
        { wa_id: SHOPPER, detail: 'stop', category: 'marketing_messages', value: 'stop', timestamp: '1755500200' },
      ],
    }),
  );

  assert.equal(batch.optOuts.length, 1);
  assert.equal(batch.optOuts[0].value, 'stop');
  assert.equal(batch.optOuts[0].waId, SHOPPER);
});

test('parse: a resume clears rather than sets the opt-out', () => {
  const batch = parseWebhook(
    envelope('user_preferences', {
      metadata: { phone_number_id: PHONE_ID },
      user_preferences: [{ wa_id: SHOPPER, category: 'marketing_messages', value: 'resume' }],
    }),
  );

  assert.equal(batch.optOuts[0].value, 'resume');
});

test('parse: a template pause is captured with its reason', () => {
  const batch = parseWebhook(
    envelope('message_template_status_update', {
      event: 'PAUSED',
      message_template_id: 1234567890,
      message_template_name: 'occasion_picker',
      message_template_language: 'en_US',
      reason: 'NONE',
      other_info: { title: 'FIRST_PAUSE', description: 'Paused for 3 hours' },
    }),
  );

  assert.equal(batch.templateEvents.length, 1);
  assert.equal(batch.templateEvents[0].name, 'occasion_picker');
  assert.equal(batch.templateEvents[0].event, 'PAUSED');
});

test('parse: a template quality drop is captured', () => {
  const batch = parseWebhook(
    envelope('message_template_quality_update', {
      previous_quality_score: 'GREEN',
      new_quality_score: 'RED',
      message_template_id: 1234567890,
      message_template_name: 'category_picker',
    }),
  );

  // RED is the state that triggers pausing, so it must be visible.
  assert.equal(batch.templateEvents[0].event, 'QUALITY_RED');
});

test('parse: a phone number quality change is captured', () => {
  const batch = parseWebhook(
    envelope('phone_number_quality_update', {
      display_phone_number: '15551234567',
      event: 'FLAGGED',
      current_limit: 'TIER_1K',
    }),
  );

  assert.equal(batch.accountEvents.length, 1);
  assert.equal(batch.accountEvents[0].meta.event, 'FLAGGED');
});

test('parse: an account policy violation is captured', () => {
  const batch = parseWebhook(
    envelope('account_update', {
      phone_number: '15551234567',
      event: 'ACCOUNT_VIOLATION',
      violation_info: { violation_type: 'BUSINESS_POLICY' },
    }),
  );

  assert.equal(batch.accountEvents[0].meta.event, 'ACCOUNT_VIOLATION');
});

/* ------------------------------------------------------------------ *
 * Robustness
 * ------------------------------------------------------------------ */

test('parse: several changes in one payload are all handled', () => {
  // Meta batches events. Reading only entry[0].changes[0] loses the rest.
  const batch = parseWebhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: messagesValue({
              messages: [{ from: SHOPPER, id: 'wamid.A', type: 'text', text: { body: 'one' } }],
            }),
          },
          {
            field: 'messages',
            value: messagesValue({
              statuses: [{ id: 'wamid.B', status: 'read', recipient_id: SHOPPER }],
            }),
          },
        ],
      },
    ],
  });

  assert.equal(batch.messages.length, 1);
  assert.equal(batch.statuses.length, 1);
});

test('parse: several messages in one change are all handled', () => {
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({
        messages: [
          { from: SHOPPER, id: 'wamid.M1', type: 'text', text: { body: 'first' } },
          { from: SHOPPER, id: 'wamid.M2', type: 'text', text: { body: 'second' } },
        ],
      }),
    ),
  );

  assert.equal(batch.messages.length, 2);
});

test('parse: malformed payloads return an empty batch instead of throwing', () => {
  for (const bad of [null, undefined, {}, { entry: null }, { entry: [{}] }, { entry: [{ changes: [{}] }] }, 'nonsense', 42]) {
    const batch = parseWebhook(bad);
    assert.equal(batchIsEmpty(batch), true);
  }
});

test('parse: a message with no id or sender is skipped', () => {
  const batch = parseWebhook(
    envelope(
      'messages',
      messagesValue({ messages: [{ type: 'text', text: { body: 'orphan' } }] }),
    ),
  );

  assert.equal(batch.messages.length, 0);
});
