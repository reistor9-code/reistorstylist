/**
 * One-off provisioning for the two media carousel picker templates.
 *
 * WhatsApp Manager does not expose the carousel component in every account — if
 * "Add button" is the last thing in the template editor, yours is one of them.
 * The Cloud API accepts it regardless, so the templates are created here.
 *
 * Reached at:
 *   /admin/templates?token=<VERIFY_TOKEN>&waba=<WABA_ID>&app=<APP_ID>
 *
 * Safe to re-run: a duplicate name errors rather than creating anything. Delete
 * the route once the templates exist — it is gated only on VERIFY_TOKEN, which
 * is a low-entropy string you also paste into Meta's dashboard.
 *
 * The token needs `whatsapp_business_management`, which the API Setup temporary
 * token carries and a System User token carries only if you ticked it.
 */

import type { Env } from './env';

/**
 * Meta's resumable upload: open a session against the APP, push the bytes, get
 * back an opaque handle. Card headers need one of these as their approval-time
 * example image; the real per-card images are supplied at send time.
 */
async function uploadExampleImage(env: Env, appId: string, imageUrl: string): Promise<string> {
  const version = env.GRAPH_API_VERSION || 'v21.0';

  const image = await fetch(imageUrl);
  if (!image.ok) throw new Error(`could not fetch example image ${imageUrl}: ${image.status}`);
  const bytes = new Uint8Array(await image.arrayBuffer());
  const mime = image.headers.get('content-type')?.split(';')[0] || 'image/jpeg';

  const startRes = await fetch(
    `https://graph.facebook.com/${version}/${appId}/uploads` +
      `?file_length=${bytes.byteLength}&file_type=${encodeURIComponent(mime)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` } },
  );
  const start = (await startRes.json()) as { id?: string };
  if (!start.id) throw new Error(`upload session failed: ${JSON.stringify(start)}`);

  // Note the OAuth (not Bearer) scheme — a quirk of the resumable upload API.
  const finishRes = await fetch(`https://graph.facebook.com/${version}/${start.id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${env.WHATSAPP_TOKEN}`, file_offset: '0' },
    body: bytes,
  });
  const finish = (await finishRes.json()) as { h?: string };
  if (!finish.h) throw new Error(`upload failed: ${JSON.stringify(finish)}`);
  return finish.h;
}

async function createTemplate(
  env: Env,
  waba: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const version = env.GRAPH_API_VERSION || 'v21.0';
  const res = await fetch(`https://graph.facebook.com/${version}/${waba}/message_templates`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/** Every card shares one structure — a hard requirement of the format. */
function carouselTemplate(
  name: string,
  language: string,
  bodyText: string,
  cards: readonly { label: string; blurb: string }[],
  exampleHandle: string,
): Record<string, unknown> {
  return {
    name,
    language,
    // Carousel is Marketing-only, which is also why every send is billed.
    category: 'MARKETING',
    components: [
      { type: 'BODY', text: bodyText },
      {
        type: 'CAROUSEL',
        cards: cards.map((card) => ({
          components: [
            // Mandatory. A carousel card cannot be text-only.
            { type: 'HEADER', format: 'IMAGE', example: { header_handle: [exampleHandle] } },
            /*
             * No {{n}} variables here on purpose. Meta weighs a template's total
             * variable count against its main body length, and a carousel's
             * body is one short question — so a per-card count variable fails
             * validation ("Parameters words ratio exceeds limit") however long
             * the card copy is. Live counts stay on the list picker.
             */
            { type: 'BODY', text: `${card.label}\n${card.blurb}` },
            { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Choose' }] },
          ],
        })),
      },
    ],
  };
}

export async function createPickerTemplates(
  env: Env,
  waba: string,
  appId: string,
  occasions: readonly { label: string; blurb: string; cover: string }[],
  categories: readonly { label: string; blurb: string }[],
  occasionBody: string,
  categoryBody: string,
  exampleImageUrl: string,
) {
  const language = env.TEMPLATE_LANGUAGE || 'en_US';
  const exampleHandle = await uploadExampleImage(env, appId, exampleImageUrl);

  const occasion = await createTemplate(
    env,
    waba,
    carouselTemplate(
      env.OCCASION_TEMPLATE || 'occasion_picker',
      language,
      occasionBody,
      occasions.map((o) => ({ label: o.label, blurb: o.blurb })),
      exampleHandle,
    ),
  );

  const category = await createTemplate(
    env,
    waba,
    carouselTemplate(
      env.CATEGORY_TEMPLATE || 'category_picker',
      language,
      categoryBody,
      categories.map((c) => ({ label: c.label, blurb: c.blurb })),
      exampleHandle,
    ),
  );

  return { language, exampleHandle, occasion, category };
}
