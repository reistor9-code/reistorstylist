/**
 * Formatting helpers shared by every section.
 *
 * These were untyped browser functions living inside a template string. Moving
 * them here is most of the point of the refactor: `inr(revenue)` is now checked
 * against the type `revenue` actually has, and a section that passes the wrong
 * field fails at build time rather than printing "₹NaN" to a board.
 */

/** Escapes text for HTML. Every value from the database goes through this. */
export function esc(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Indian digit grouping, done by hand rather than through toLocaleString so it
 * does not depend on the runtime carrying ICU data — the same reason
 * formatINR() in copy.ts does it this way.
 */
export function inr(amount: number | null | undefined): string {
  const value = Math.round(Number(amount) || 0);
  const digits = String(Math.abs(value));
  const grouped =
    digits.length <= 3
      ? digits
      : digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + digits.slice(-3);
  return `${value < 0 ? '-' : ''}₹${grouped}`;
}

/** Plain counts, grouped the same way. */
export function n(value: number | null | undefined): string {
  const rounded = Math.round(Number(value) || 0);
  const digits = String(Math.abs(rounded));
  const grouped =
    digits.length <= 3
      ? digits
      : digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + digits.slice(-3);
  return `${rounded < 0 ? '-' : ''}${grouped}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "19 Aug" — dates are always read alongside a year-long window label. */
export function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "18 Aug, 02:42 pm" — used wherever the hour matters, such as a callback. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hours = d.getUTCHours();
  const suffix = hours < 12 ? 'am' : 'pm';
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day(iso)}, ${String(twelve).padStart(2, '0')}:${minutes} ${suffix}`;
}

/** A product's name, falling back to its id when the logger never saw a title. */
export function pname(p: { title?: string | null; productId: string }): string {
  return p.title || `Product ${p.productId}`;
}

/** Digits only, for a tel: link that actually dials. */
export function dialable(waId: string): string {
  return `+${String(waId).replace(/\D/g, '')}`;
}

/** The same number spaced for reading. Indian numbers arrive as 91XXXXXXXXXX. */
export function prettyNumber(waId: string): string {
  const d = String(waId).replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91')
    ? `+91 ${d.slice(2, 7)} ${d.slice(7)}`
    : `+${d}`;
}

/** Bar colours, cycled by index so adjacent rows never repeat. */
export const HUE = [
  '--peri',
  '--lav',
  '--mauve',
  '--pink',
  '--gold',
  '--yellow',
  '--peri',
  '--lav',
] as const;

export const hueAt = (i: number): string => HUE[i % HUE.length];

/** Shown wherever a section has nothing to report, in place of an empty box. */
export const empty = (message: string, style = ''): string =>
  `<div class="empty"${style ? ` style="${style}"` : ''}>${message}</div>`;

/** The standard card header: a title and an optional pill on the right. */
export const cardHead = (title: string, pill?: string): string =>
  `<div class="ch"><h3>${esc(title)}</h3>${pill ? `<span class="pill">${pill}</span>` : ''}</div>`;

/** A footnote under a section. These carry the caveats, so they are not decoration. */
export const note = (html: string, style = ''): string =>
  `<div class="note"${style ? ` style="${style}"` : ''}>${html}</div>`;
