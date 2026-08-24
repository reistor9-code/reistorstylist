/**
 * Turns a stored event back into what the shopper actually saw.
 *
 * The log keeps machine values, correctly — `payload_id` is `occ:casual` and an
 * outbound template is `[template: occasion_picker_v2]`, because those are the
 * things the flow branches on and the things worth counting. They are also
 * unreadable, so a transcript came out as a list of identifiers rather than a
 * conversation, and nobody could see where a shopper got confused.
 *
 * Nothing here changes what is captured. It is a rendering layer over rows
 * that already exist, so it works on every conversation already logged.
 */

import { COPY } from '../copy.js';
import { CATEGORIES, OCCASIONS, categoryLabel, occasionLabel } from '../catalog.js';

export interface TranscriptMessage {
  direction: string;
  body: string | null;
  messageType: string | null;
  payloadId: string | null;
  flowStep: string | null;
  ts: string;
}

/**
 * Button ids to the words printed on them.
 *
 * Kept here rather than imported because a button's label can change while old
 * transcripts keep the id the shopper tapped at the time — `act:catalog` said
 * "Browse Catalog" before it said "Browse Category". This table is what the
 * button says now, which is the readable answer; the id stays in the row.
 */
const ACTIONS: Record<string, string> = {
  'act:more': 'Show More Looks',
  'act:browse': 'Browse Category',
  'act:catalog': 'Browse Category',
  'act:main_menu': 'Main Menu',
  'act:callback': 'Talk to Stylist',
  'act:restart_occasion': 'Pick Occasion',
  'act:again': 'Browse Again',
  'act:end': 'End Chat',
  'act:paid': 'I have paid',
};

/** A picker template, written out as the question and the cards under it. */
function pickerText(templateName: string): string | null {
  if (templateName.startsWith('occasion_picker')) {
    return [COPY.occasionHeader, ...OCCASIONS.map((o) => `• ${o.label}`)].join('\n');
  }
  if (templateName.startsWith('category_picker')) {
    return [COPY.categoryHeader, ...CATEGORIES.map((c) => `• ${c.label}`)].join('\n');
  }
  return null;
}

/**
 * What the shopper tapped, in the words they saw.
 *
 * Returns null for anything unrecognised so the caller can fall back rather
 * than invent a label for an id this build has never heard of.
 */
function tapText(payloadId: string, names: Map<string, string>): string | null {
  if (ACTIONS[payloadId]) return ACTIONS[payloadId];

  const [kind, first, second] = payloadId.split(':');

  switch (kind) {
    case 'occ':
      return occasionLabel(first);
    case 'cat':
      return categoryLabel(first);
    case 'look':
      return names.get(first) ?? `Product ${first}`;
    case 'size':
      // size:<productId>:<size> — the garment is already on screen above, so
      // the size alone is what the tap actually said.
      return second ? `Size ${second}` : null;
    case 'order':
      return `Order ${first}`;
    default:
      return null;
  }
}

/** One row, rewritten for a human. Everything except `body` is untouched. */
export function humanise(m: TranscriptMessage, names: Map<string, string>): TranscriptMessage {
  // A tap carries no text of its own, so the id is the only thing to read.
  if (m.payloadId) {
    const tapped = tapText(m.payloadId, names);
    if (tapped) return { ...m, body: tapped };
  }

  if (!m.body) return m;

  const template = /^\[template:\s*([^\]]+)\]$/.exec(m.body);
  if (template) {
    const written = pickerText(template[1].trim());
    // An unrecognised template still reads better without the brackets.
    return { ...m, body: written ?? `[${template[1].trim()}]` };
  }

  /*
   * Message types whose text lives in the card rather than the body. The
   * carousel and product messages do carry a body — the picks echo — so they
   * are already readable and are deliberately not listed.
   */
  const bare: Record<string, string> = {
    '[catalog_message]': 'Catalogue card',
    '[product]': 'A product card',
    '[product_list]': 'A list of products',
    '[image]': 'An image',
  };
  if (bare[m.body]) return { ...m, body: bare[m.body] };

  return m;
}

export function humaniseTranscript(
  messages: TranscriptMessage[],
  names: Map<string, string>,
): TranscriptMessage[] {
  return messages.map((m) => humanise(m, names));
}
