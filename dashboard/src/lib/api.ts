/**
 * The dashboard API contract.
 *
 * These types mirror what the Worker returns from /dashboard/api — the
 * DashboardData in src/dashboard/queries.ts plus the `analytics` block from
 * queries-analytics.ts. They are written out rather than imported because
 * this app builds separately from the Worker; when the Worker's shape
 * changes, this file is the one place to follow it.
 */

export interface FunnelStep {
  step: string;
  label: string;
  sessions: number;
  lostPct: number;
}

export interface Callback {
  id: number;
  waId: string;
  profileName: string | null;
  occasion: string | null;
  category: string | null;
  productsSeen: string[];
  requestedAt: string;
  hoursWaiting: number;
  overdue: boolean;
  windowOpen: boolean;
  marketingOptOut?: boolean;
}

export interface TopProduct {
  productId: string;
  title: string;
  sku: string | null;
  unitsSold: number;
  revenueINR: number;
  orders: number;
  lastSoldAt: string | null;
}

export interface ProductConversion {
  productId: string;
  title: string | null;
  sku: string | null;
  timesShown: number;
  timesSized: number;
  unitsSold: number;
  conversionPct: number;
}

export interface LostDemand {
  productId: string;
  title: string | null;
  sku: string | null;
  size: string | null;
  times: number;
  lastAt: string | null;
}

export interface AcquisitionRow {
  source: string;
  campaign: string;
  sessions: number;
  engaged: number;
  orders: number;
  revenueINR: number;
  conversionPct: number;
}

export interface QualityPoint {
  day: string;
  rating: 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';
  messagingTier: string | null;
}

export interface SearchMiss {
  normalised: string;
  example: string;
  times: number;
  shoppers: number;
  lastStep: string | null;
}

export interface AbandonedCart {
  sessionId: string;
  waId: string;
  profileName: string | null;
  productPicked: string | null;
  sizePicked: string | null;
  hoursSince: number;
  windowOpen: boolean;
  marketingOptOut: boolean;
}

export interface StockGap {
  productId: string;
  title: string | null;
  size: string | null;
  turnedAway: number;
  stockNow: number;
  stillGone: boolean;
}

export interface Conversation {
  waId: string;
  messages: number;
  lastAt: string;
  lastStep: string | null;
}

export interface Message {
  direction: string;
  body: string | null;
  messageType: string | null;
  payloadId: string | null;
  flowStep: string | null;
  ts: string;
}

export interface AnalyticsData {
  acquisition: AcquisitionRow[];
  conversations: Conversation[];
  risk: {
    quality: QualityPoint[];
    optOuts: { templateName: string; optOuts: number }[];
    worstRating: QualityPoint['rating'] | null;
    declined: boolean;
  };
  searchMisses: SearchMiss[];
  timing: {
    medianMinutes: number | null;
    p90Minutes: number | null;
    orders: number;
    buyers: number;
    repeatBuyers: number;
    repeatPct: number;
    aovINR: number;
  };
  hourHeatmap: { dow: number; hour: number; messages: number }[];
  abandonedCarts: AbandonedCart[];
  callbackOutcome: { requests: number; called: number; ordersAfter: number; revenueINR: number };
  stockGaps: StockGap[];
  /** Views that failed. Empty is healthy; anything here must be shown. */
  errors: string[];
}

/**
 * Not signed in — distinct from "not allowed", because only one of them has a
 * button. A 403 means the account exists and may not see this; a 401 means
 * there is no account yet and Google is one click away.
 */
export class NotSignedIn extends Error {
  constructor(
    message: string,
    readonly signInUrl: string | null,
    readonly reason: string | null = null,
  ) {
    super(message);
    this.name = 'NotSignedIn';
  }
}

export interface Viewer {
  email: string;
  role: 'admin' | 'viewer';
}

export interface DashboardData {
  range: { from: string; to: string; phoneNumberId?: string };
  generatedAt: string;
  callbacks: Callback[];
  funnel: FunnelStep[];
  topProducts: TopProduct[];
  productConversion: ProductConversion[];
  lostDemand: LostDemand[];
  demandGrid: { occasion: string; category: string; requests: number; hadNothing: number; orders: number }[];
  campaigns: { templateName: string; sent: number; delivered: number; readPct: number; clickPct: number }[];
  delivery: { sent: number; delivered: number; read: number; failed: number; deliveredPct: number; readPct: number };
  cost: { billableMessages: number; freeMessages: number; byCategory: { category: string; messages: number }[] };
  attrition: { optedOut: number; abandoned: number; droppedByStep: { step: string; sessions: number }[] };
  health: {
    qualityRating: string | null;
    messagingTier: string | null;
    capturedAt: string | null;
    templates: { name: string; status: string; quality: string | null }[];
  };
  revenue: { orders: number; revenueINR: number; averageOrderINR: number; costPerOrder: number | null };
  analytics: AnalyticsData;
  /** Who the server thinks is reading. Absent on an older deploy. */
  viewer?: Viewer;
}

/**
 * The token comes from the URL and is never stored.
 *
 * Putting it in localStorage would leave a credential that reads every
 * shopper's phone number sitting in the browser of any shared machine this
 * is opened on.
 */
export function tokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

/**
 * The shape used when the Worker sends no `analytics` block, and the floor
 * that a partial one is merged onto.
 *
 * Defaulting the whole block was not enough: a Worker one deploy behind sends
 * an `analytics` object that is present but missing whichever field was added
 * last, and reading `.length` off that undefined crashes the tab. Every field
 * is now filled individually, so a version gap costs an empty tile rather
 * than the page.
 */
const NO_ANALYTICS: AnalyticsData = {
  acquisition: [],
  conversations: [],
  risk: { quality: [], optOuts: [], worstRating: null, declined: false },
  searchMisses: [],
  timing: {
    medianMinutes: null,
    p90Minutes: null,
    orders: 0,
    buyers: 0,
    repeatBuyers: 0,
    repeatPct: 0,
    aovINR: 0,
  },
  hourHeatmap: [],
  abandonedCarts: [],
  callbackOutcome: { requests: 0, called: 0, ordersAfter: 0, revenueINR: 0 },
  stockGaps: [],
  errors: ['The Worker sent no analytics block — deploy the current build to fill these tabs.'],
};

export async function fetchDashboard(days: number, phone: string): Promise<DashboardData> {
  const qs = new URLSearchParams({ token: tokenFromUrl(), days: String(days) });
  if (phone) qs.set('phone', phone);

  const res = await fetch(`/dashboard/api?${qs}`, { headers: { accept: 'application/json' } });

  /*
   * The sign-in case, handled before anything else. The server answers 401
   * with the URL to send them to, so this file never has to know how sign-in
   * is implemented — only that it is somewhere.
   */
  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; signInUrl?: string };
    throw new NotSignedIn(
      body.error ?? 'Sign in to see the dashboard.',
      body.signInUrl ?? null,
      new URLSearchParams(window.location.search).get('error'),
    );
  }

  if (res.status === 403) throw new Error('This account does not have access to the dashboard.');
  if (res.status === 503) throw new Error(await res.text());
  if (!res.ok) throw new Error(`The dashboard API answered ${res.status}.`);

  const body = (await res.json()) as Partial<DashboardData>;

  /*
   * Every list is defaulted rather than trusted. The API is ours, but a shape
   * mismatch between a deployed Worker and a deployed front end is the normal
   * state of affairs for a few minutes after any release — and it must not be
   * the difference between a working page and a black one.
   */
  return {
    range: body.range ?? { from: '', to: '' },
    generatedAt: body.generatedAt ?? new Date().toISOString(),
    callbacks: body.callbacks ?? [],
    funnel: body.funnel ?? [],
    topProducts: body.topProducts ?? [],
    productConversion: body.productConversion ?? [],
    lostDemand: body.lostDemand ?? [],
    demandGrid: body.demandGrid ?? [],
    campaigns: body.campaigns ?? [],
    delivery: body.delivery ?? { sent: 0, delivered: 0, read: 0, failed: 0, deliveredPct: 0, readPct: 0 },
    cost: body.cost ?? { billableMessages: 0, freeMessages: 0, byCategory: [] },
    attrition: body.attrition ?? { optedOut: 0, abandoned: 0, droppedByStep: [] },
    health: body.health ?? { qualityRating: null, messagingTier: null, capturedAt: null, templates: [] },
    revenue: body.revenue ?? { orders: 0, revenueINR: 0, averageOrderINR: 0, costPerOrder: null },
    analytics: mergeAnalytics(body.analytics),
    viewer: body.viewer,
  };
}

/**
 * Fills each analytics field individually.
 *
 * Written out rather than spread so that adding a field to AnalyticsData
 * forces a line here — a spread would silently let the next new field through
 * as undefined and reintroduce exactly this crash.
 */
function mergeAnalytics(a?: Partial<AnalyticsData>): AnalyticsData {
  if (!a) return NO_ANALYTICS;

  const risk = a.risk ?? NO_ANALYTICS.risk;

  return {
    acquisition: a.acquisition ?? [],
    conversations: a.conversations ?? [],
    risk: {
      quality: risk.quality ?? [],
      optOuts: risk.optOuts ?? [],
      worstRating: risk.worstRating ?? null,
      declined: risk.declined ?? false,
    },
    searchMisses: a.searchMisses ?? [],
    timing: { ...NO_ANALYTICS.timing, ...(a.timing ?? {}) },
    hourHeatmap: a.hourHeatmap ?? [],
    abandonedCarts: a.abandonedCarts ?? [],
    callbackOutcome: { ...NO_ANALYTICS.callbackOutcome, ...(a.callbackOutcome ?? {}) },
    stockGaps: a.stockGaps ?? [],
    errors: a.errors ?? [],
  };
}

export async function fetchTranscript(waId: string): Promise<Message[]> {
  const qs = new URLSearchParams({ token: tokenFromUrl(), wa: waId });
  const res = await fetch(`/dashboard/api/transcript?${qs}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return [];
  return res.json();
}

export async function markCalled(id: number): Promise<void> {
  const res = await fetch(`/dashboard/api/callback?token=${encodeURIComponent(tokenFromUrl())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, agent: 'dashboard' }),
  });
  if (!res.ok) throw new Error(`Could not save: ${res.status}`);
}
