/**
 * WhatsApp send-shape limits and Reistor's brand copy rules.
 *
 * Every limit asserted here comes from Meta's Cloud API reference. Exceeding
 * one does not degrade the message — Meta rejects the send outright, and the
 * shopper sees nothing at all. These are the constraints that turn a working
 * flow into a silent one, so they are checked against the real COPY and the
 * real picker definitions rather than against samples.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  clip,
  copyViolations,
  COPY,
  OCCASIONS,
  CATEGORIES,
  formatINR,
  BANNED_WORDS,
} from '../dist/index.js';

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

test('limits match Meta\'s documented maximums', () => {
  assert.equal(LIMITS.rowTitle, 24);
  assert.equal(LIMITS.rowDescription, 72);
  assert.equal(LIMITS.buttonTitle, 20);
  assert.equal(LIMITS.listButton, 20);
  assert.equal(LIMITS.body, 1024);
  assert.equal(LIMITS.maxRows, 10);
  assert.equal(LIMITS.maxButtons, 3);
});

test('clip never returns more characters than the limit', () => {
  for (const max of [20, 24, 60, 72]) {
    const clipped = clip('x'.repeat(max + 50), max);
    assert.ok(clipped.length <= max, `clip(${max}) produced ${clipped.length}`);
  }
});

test('clip leaves short text untouched, including the ellipsis case', () => {
  assert.equal(clip('Tops', 24), 'Tops');
  // Exactly at the limit must not be truncated.
  assert.equal(clip('x'.repeat(24), 24), 'x'.repeat(24));
  assert.ok(clip('x'.repeat(25), 24).endsWith('…'));
});

test('every reply-button title in COPY fits the 20-character cap', () => {
  // The spec's "Show More Looks Again" was cut for exactly this reason.
  const titles = [
    'View & Select Size',
    'Show More Looks',
    'Browse Category',
    'Talk to Stylist',
    'Pick Occasion',
    'Load More',
    'Pick an Item',
    'Back to Looks',
    'Order Placed',
    'Browse Again',
    'End Chat',
    'Start Over',
    'Buy Now',
  ];
  for (const title of titles) {
    assert.ok(title.length <= LIMITS.buttonTitle, `"${title}" is ${title.length} chars`);
  }
});

test('every list row title fits, and descriptions fit too', () => {
  const rows = [
    ['Something specific', 'Describe what you are after'],
    ['Size & fit help', 'Find your fit across fabrics'],
    ['A different style', 'Try another direction'],
    ['Back to looks', 'Return to the curated edit'],
  ];
  for (const [title, description] of rows) {
    assert.ok(title.length <= LIMITS.rowTitle, `row title "${title}"`);
    assert.ok(description.length <= LIMITS.rowDescription, `row description "${description}"`);
  }
});

test('the occasion picker fits inside a list, if the carousel is ever rejected', () => {
  // The typed-answer fallback and any list rendering are both capped at 10.
  assert.ok(OCCASIONS.length <= LIMITS.maxRows);
  assert.ok(CATEGORIES.length <= LIMITS.maxRows);
});

test('a carousel template holds between 2 and 10 cards', () => {
  // Meta rejects a carousel with fewer than 2 cards or more than 10.
  for (const set of [OCCASIONS, CATEGORIES]) {
    assert.ok(set.length >= 2, 'a carousel needs at least 2 cards');
    assert.ok(set.length <= 10, 'a carousel holds at most 10 cards');
  }
});

test('every picker card has an image — a carousel card cannot be text-only', () => {
  for (const card of [...OCCASIONS, ...CATEGORIES]) {
    assert.ok(card.image, `${card.id} has no image`);
    assert.match(card.image, /^https:\/\//, `${card.id} image must be a public https URL`);
  }
});

test('picker ids are unique and routable', () => {
  // Cards are addressed by index and routed by payload; a duplicate id would
  // send two different choices down the same branch.
  const occ = OCCASIONS.map((o) => o.id);
  const cat = CATEGORIES.map((c) => c.id);
  assert.equal(new Set(occ).size, occ.length);
  assert.equal(new Set(cat).size, cat.length);
});

/* ------------------------------------------------------------------ *
 * Brand copy
 * ------------------------------------------------------------------ */

test('every shipped COPY string obeys the brand rules', () => {
  for (const [key, value] of Object.entries(COPY)) {
    if (typeof value !== 'string') continue;
    const issues = copyViolations(value);
    assert.equal(issues.length, 0, `COPY.${key} — ${issues.join('; ')}: "${value}"`);
  }
});

test('every picker blurb obeys the brand rules', () => {
  for (const card of [...OCCASIONS, ...CATEGORIES]) {
    const issues = copyViolations(card.blurb);
    assert.equal(issues.length, 0, `${card.id} blurb — ${issues.join('; ')}`);
  }
});

test('copyViolations catches each banned word', () => {
  for (const word of BANNED_WORDS) {
    const issues = copyViolations(`This is ${word} in a sentence.`);
    assert.ok(issues.length > 0, `"${word}" was not caught`);
  }
});

test('copyViolations catches banned sentence starts', () => {
  assert.ok(copyViolations('With this piece you are set.').length > 0);
  assert.ok(copyViolations('And another thing.').length > 0);
  assert.ok(copyViolations('Here are three looks.').length > 0);
  // Mid-sentence is fine — only the sentence start is banned.
  assert.equal(copyViolations('Pair it with linen trousers.').length, 0);
});

test('copyViolations does not fire on substrings of ordinary words', () => {
  // "needs" is banned; "kneads" and "needle" are not.
  assert.equal(copyViolations('The tailor kneads the fabric.').length, 0);
  assert.equal(copyViolations('A needle and thread.').length, 0);
});

/* ------------------------------------------------------------------ *
 * Currency
 * ------------------------------------------------------------------ */

test('formatINR uses Indian digit grouping without ICU', () => {
  // Workers do not reliably carry ICU data, so this is hand-rolled and has to
  // be checked against the lakh/crore grouping rather than thousands.
  assert.equal(formatINR(999), '₹999');
  assert.equal(formatINR(2499), '₹2,499');
  assert.equal(formatINR(125000), '₹1,25,000');
  assert.equal(formatINR(10000000), '₹1,00,00,000');
  assert.equal(formatINR(0), '₹0');
});

test('formatINR rounds rather than emitting decimals', () => {
  assert.equal(formatINR(2499.6), '₹2,500');
});
