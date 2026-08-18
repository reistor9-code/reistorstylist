/**
 * Webhook parsing.
 *
 * One callback URL carries every event Meta sends about the business account,
 * distinguished by `changes[].field`. The original bot read only inbound
 * messages and discarded the rest — including delivery receipts, which carry
 * the `pricing` object and are therefore the only per-message cost data that
 * exists outside the monthly invoice.
 *
 * This parser is deliberately total: it returns a batch covering every field
 * worth recording, and never throws on a shape it does not recognise. A
 * malformed payload must not cost a shopper their reply, so unknown structures
 * are logged and skipped rather than propagated.
 */

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export interface InboundMessage {
  waId: string;
  messageId: string;
  messageType: string;
  profileName?: string;
  timestamp?: string;
  /** Free text, when the shopper typed. */
  text?: string;
  /** Routing id from a list row, reply button, or template quick reply. */
  replyId?: string;
  /** Present when the shopper sent a cart from the catalog. */
  order?: {
    catalogId?: string;
    items: { retailerId: string; quantity: number; price: number; currency: string }[];
  };
}

export interface StatusUpdate {
  wamid: string;
  waId?: string;
  status: string;
  timestamp?: string;
  billable?: boolean;
  pricingCategory?: string;
  pricingType?: string;
  errorCode?: number;
  errorTitle?: string;
}

export interface OptOutUpdate {
  waId: string;
  value: 'stop' | 'resume';
  category?: string;
  timestamp?: string;
}

export interface TemplateEvent {
  name: string;
  event: string;
  meta: Record<string, unknown>;
}

export interface AccountEvent {
  type: string;
  meta: Record<string, unknown>;
}

export interface WebhookBatch {
  phoneNumberId?: string;
  messages: InboundMessage[];
  statuses: StatusUpdate[];
  optOuts: OptOutUpdate[];
  templateEvents: TemplateEvent[];
  accountEvents: AccountEvent[];
}

export function emptyBatch(): WebhookBatch {
  return { messages: [], statuses: [], optOuts: [], templateEvents: [], accountEvents: [] };
}

export function batchIsEmpty(b: WebhookBatch): boolean {
  return (
    b.messages.length === 0 &&
    b.statuses.length === 0 &&
    b.optOuts.length === 0 &&
    b.templateEvents.length === 0 &&
    b.accountEvents.length === 0
  );
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

function parseMessage(raw: any, profileName?: string): InboundMessage | null {
  const waId: string | undefined = raw?.from;
  const messageId: string | undefined = raw?.id;
  if (!waId || !messageId) return null;

  const base = {
    waId,
    messageId,
    messageType: String(raw.type ?? 'unknown'),
    profileName,
    timestamp: raw.timestamp ? new Date(Number(raw.timestamp) * 1000).toISOString() : undefined,
  };

  if (raw.type === 'text') {
    return { ...base, text: String(raw.text?.body ?? '') };
  }

  if (raw.type === 'interactive') {
    const replyId =
      raw.interactive?.list_reply?.id ?? raw.interactive?.button_reply?.id ?? undefined;
    // A Flow completion arrives here too, carrying its response payload.
    const flowResponse = raw.interactive?.nfm_reply?.response_json;
    if (replyId) return { ...base, replyId: String(replyId) };
    if (flowResponse) return { ...base, text: '', replyId: undefined };
    return base;
  }

  if (raw.type === 'button') {
    /*
     * Template quick replies — carousel cards included — land here rather than
     * under `interactive`. The routing id is in `payload`; `text` is only the
     * visible label, which is why both are read but payload wins.
     */
    const payload = raw.button?.payload;
    if (payload) return { ...base, replyId: String(payload) };
    return { ...base, text: String(raw.button?.text ?? '') };
  }

  if (raw.type === 'order') {
    /*
     * The shopper sent a cart from the catalog. This is the ONLY signal Meta
     * gives that somebody engaged with a product card — opening a product page
     * fires no webhook at all — so it is the closest thing to a view-through
     * this integration can observe.
     */
    const items = Array.isArray(raw.order?.product_items) ? raw.order.product_items : [];
    return {
      ...base,
      order: {
        catalogId: raw.order?.catalog_id,
        items: items.map((i: any) => ({
          retailerId: String(i?.product_retailer_id ?? ''),
          quantity: Number(i?.quantity ?? 1),
          price: Number(i?.item_price ?? 0),
          currency: String(i?.currency ?? 'INR'),
        })),
      },
      text: raw.order?.text ? String(raw.order.text) : undefined,
    };
  }

  // Images, audio, location, reactions, system messages. Recorded so the
  // conversation log is complete, with no text for the router to act on.
  return base;
}

/* ------------------------------------------------------------------ *
 * Statuses
 * ------------------------------------------------------------------ */

function parseStatus(raw: any): StatusUpdate | null {
  const wamid: string | undefined = raw?.id;
  const status: string | undefined = raw?.status;
  if (!wamid || !status) return null;

  const error = Array.isArray(raw.errors) ? raw.errors[0] : undefined;

  return {
    wamid,
    waId: raw.recipient_id ? String(raw.recipient_id) : undefined,
    status: String(status),
    timestamp: raw.timestamp ? new Date(Number(raw.timestamp) * 1000).toISOString() : undefined,
    // The pricing object is the whole reason to keep these. `billable` and
    // `category` together give cost attribution per message, in real time.
    billable: typeof raw.pricing?.billable === 'boolean' ? raw.pricing.billable : undefined,
    pricingCategory: raw.pricing?.category ? String(raw.pricing.category) : undefined,
    pricingType: raw.pricing?.type ? String(raw.pricing.type) : undefined,
    errorCode: error?.code ? Number(error.code) : undefined,
    errorTitle: error?.title ? String(error.title) : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * The whole payload
 * ------------------------------------------------------------------ */

export function parseWebhook(body: any): WebhookBatch {
  const batch = emptyBatch();

  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];

    for (const change of changes) {
      const field = String(change?.field ?? '');
      const value = change?.value;
      if (!value) continue;

      if (value.metadata?.phone_number_id) {
        batch.phoneNumberId = String(value.metadata.phone_number_id);
      }

      switch (field) {
        case 'messages': {
          // Profile names arrive alongside, not inside, the message.
          const contacts = Array.isArray(value.contacts) ? value.contacts : [];
          const nameFor = (waId: string): string | undefined =>
            contacts.find((c: any) => c?.wa_id === waId)?.profile?.name;

          for (const raw of Array.isArray(value.messages) ? value.messages : []) {
            const parsed = parseMessage(raw, raw?.from ? nameFor(String(raw.from)) : undefined);
            if (parsed) batch.messages.push(parsed);
          }

          // Delivery receipts share the `messages` field — they are not a
          // separate subscription, and discarding them discards all cost data.
          for (const raw of Array.isArray(value.statuses) ? value.statuses : []) {
            const parsed = parseStatus(raw);
            if (parsed) batch.statuses.push(parsed);
          }
          break;
        }

        case 'user_preferences': {
          for (const pref of Array.isArray(value.user_preferences) ? value.user_preferences : []) {
            const waId = pref?.wa_id;
            const v = pref?.value;
            if (!waId || (v !== 'stop' && v !== 'resume')) continue;
            batch.optOuts.push({
              waId: String(waId),
              value: v,
              category: pref?.category ? String(pref.category) : undefined,
              timestamp: pref?.timestamp
                ? new Date(Number(pref.timestamp) * 1000).toISOString()
                : undefined,
            });
          }
          break;
        }

        case 'message_template_status_update': {
          batch.templateEvents.push({
            name: String(value.message_template_name ?? 'unknown'),
            event: String(value.event ?? 'unknown'),
            meta: {
              templateId: value.message_template_id,
              language: value.message_template_language,
              reason: value.reason,
              disableInfo: value.disable_info,
              otherInfo: value.other_info,
            },
          });
          break;
        }

        case 'message_template_quality_update': {
          batch.templateEvents.push({
            name: String(value.message_template_name ?? 'unknown'),
            event: `QUALITY_${String(value.new_quality_score ?? 'UNKNOWN')}`,
            meta: {
              templateId: value.message_template_id,
              previous: value.previous_quality_score,
              current: value.new_quality_score,
            },
          });
          break;
        }

        case 'phone_number_quality_update': {
          // Pushed, so the dashboard's quality tile needs no polling.
          batch.accountEvents.push({
            type: 'quality',
            meta: {
              displayPhoneNumber: value.display_phone_number,
              event: value.event,
              currentLimit: value.current_limit,
            },
          });
          break;
        }

        case 'account_alerts': {
          batch.accountEvents.push({
            type: 'account',
            meta: {
              alertType: value.alert_type,
              severity: value.alert_severity,
              status: value.alert_status,
              description: value.alert_description,
              entityType: value.entity_type,
            },
          });
          break;
        }

        case 'account_update': {
          // Carries policy violations and bans — the events worth seeing on a
          // dashboard rather than in an unread email.
          batch.accountEvents.push({
            type: 'account',
            meta: {
              event: value.event,
              phoneNumber: value.phone_number,
              banInfo: value.ban_info,
              violationInfo: value.violation_info,
              restrictionInfo: value.restriction_info,
            },
          });
          break;
        }

        case 'business_capability_update': {
          batch.accountEvents.push({
            type: 'account',
            meta: {
              event: 'capability_update',
              maxDailyConversationPerPhone: value.max_daily_conversation_per_phone,
              maxPhoneNumbersPerBusiness: value.max_phone_numbers_per_business,
            },
          });
          break;
        }

        default:
          console.log('[inbound:unhandled-field]', field);
      }
    }
  }

  return batch;
}
