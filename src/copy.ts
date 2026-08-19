/**
 * Brand copy and the two formatters that shape it.
 */

/* ------------------------------------------------------------------ *
 * Brand copy
 *
 * Every user-facing string is written out here and written to the rules:
 * never "should", "need", "pulled-together", "effortless", "great", "best",
 * "lovely choice" or "fluid"; no sentence opens with "With", "And" or "Here";
 * prices are rupees as ₹2,499; fabrics named when natural.
 *
 * The rules are held by hand rather than checked at runtime — nothing here
 * is generated, so there is no output to police.
 * ------------------------------------------------------------------ */

/** Fills `{name}` placeholders in a COPY string. Unknown keys become ''. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

export const COPY = {
  welcome:
    "Hi there! 👋 I'm Reistor AI Stylist. I'll help you find the perfect outfit for any occasion. " +
    "Two questions and I'll put a look together for you ✨",
  // Both are the approved templates' body text — see createCarouselTemplates().
  occasionHeader: "What's the occasion?",
  categoryHeader: 'What type of clothing are you looking for?',
  moreLooksIntro: 'Another round, same brief:',
  // Shown when the exact occasion × category pair is empty and the edit was
  // widened instead of dead-ended — see widenCandidates(). {placeholders} are
  // filled by fill().
  widenedToOccasion: 'Nothing in {category} for {occasion} yet. Three picks for {phrase} instead:',
  widenedToCategory: 'Nothing styled for {occasion} yet. Three picks from {category} instead:',
  widenedToShelf: 'Nothing styled for that combination yet. Three from the current edit:',
  nothingInStock:
    'Everything is off the shelf right now. Talk to our stylist and I will flag what lands next.',
  looksUnavailable:
    'Those looks are not reachable right now. Try another edit, or talk to our stylist.',
  noMoreLooks: 'That is the full edit for this brief. Browse the category or talk to our stylist.',
  whatNext: 'What next?',
  catalogUnavailable: 'The catalogue is not opening right now. Start again from the top.',
  browseCatalog: 'The full Reistor catalogue, open it and browse everything in stock.',
  sizeHeader: 'Choose your size',
  sizeBody: 'Only sizes in stock are listed.',
  checkoutBody: 'Your size is held in the bag. Tap below to check out on reistor.in.',
  afterCheckout: 'Tap below once you are back from checkout.',
  orderConfirmed: 'Order Confirmed! Thank you for shopping with Reistor.',
  stylistCallback: 'A stylist from our team will call you on this number within 24 hours.',
  goodbye: 'Thanks for shopping with Reistor. Message anytime for a new look ✨',
  tapAnOption: 'Tap an option below to keep going.',
  // Meta rejects a product message without a body — "(#131009) The parameter
  // interactive['body'] is required" — so the mandatory line confirms the two
  // choices back to the shopper rather than being filler. Names and prices are
  // already on the cards, drawn from the catalog.
  picksEcho: '{occasion} · {category}',
  // The carousel is the end of the scripted flow, so there is no menu to point
  // at — the cards and the product page behind them are the next step.
  tapACard: 'Tap a card above for the full look.',
  // Only reachable if the carousel template send is rejected. The typed-name
  // shortcut in handleText() picks these up, so the flow still moves.
  occasionTypePrompt:
    'Type the occasion you are dressing for — Work & Meeting, Vacation & Travel, Casual & Brunch, Dinner Date or Loungewear.',
  categoryTypePrompt:
    'Type a category to narrow the edit — Tops, Dresses, Bottoms, Jackets, Jumpsuits or Co-ord Sets.',
} as const;


/** Indian digit grouping without relying on the runtime's ICU data. */
export function formatINR(amount: number): string {
  const digits = String(Math.round(amount));
  if (digits.length <= 3) return `₹${digits}`;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `₹${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}


/** Capitalises the first letter — fabrics arrive lower-case from Shopify. */
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
