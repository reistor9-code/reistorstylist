/**
 * Configuration, resolved per platform.
 *
 * On Cloudflare, config arrives as the `env` argument to fetch() — vars from
 * wrangler.toml, secrets from `wrangler secret put`. Nothing to do.
 *
 * On Linode there is no such argument: the process reads its own environment,
 * populated from a .env file loaded by systemd. This module builds the same
 * shape from `process.env` so the bot's code cannot tell the difference.
 */

/** Every configuration key the bot reads, in one place. */
export const CONFIG_KEYS = [
  // WhatsApp / Meta
  'WHATSAPP_TOKEN',
  'PHONE_NUMBER_ID',
  'VERIFY_TOKEN',
  'APP_SECRET',
  'WABA_ID',
  'GRAPH_API_VERSION',
  'CATALOG_ID',
  'OCCASION_TEMPLATE',
  'CATEGORY_TEMPLATE',
  'TEMPLATE_LANGUAGE',

  // Shopify (India)
  'IND_SHOPIFY_STORE',
  'IND_SHOPIFY_STORE_ID',
  'IND_SHOPIFY_API_VERSION',
  'IND_SHOPIFY_API_KEY',
  'IND_SHOPIFY_API_SECRET',

  // Supabase
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',

  // Dashboard
  'DASHBOARD_TOKEN',

  // Deployment
  'PORT',
  'PUBLIC_BASE_URL',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type Config = Partial<Record<ConfigKey, string>>;

/**
 * Reads configuration from the process environment.
 *
 * Values are trimmed because a secret pasted into a .env file routinely picks
 * up a trailing space or newline, and a token with whitespace fails
 * authentication with an error that names neither the token nor the space.
 */
export function configFromProcess(source: Record<string, string | undefined>): Config {
  const out: Config = {};
  for (const key of CONFIG_KEYS) {
    const raw = source[key];
    if (raw !== undefined && raw !== '') out[key] = raw.trim();
  }
  return out;
}

/**
 * Names of settings that must be present for the bot to answer a message at
 * all. Checked at boot so a missing secret surfaces in the startup log rather
 * than as a silently unanswered shopper.
 */
export const REQUIRED_KEYS: ConfigKey[] = ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN'];

export function missingRequired(config: Config): ConfigKey[] {
  return REQUIRED_KEYS.filter((key) => !config[key]);
}

/**
 * Settings that are not required, but whose absence quietly disables a whole
 * feature. Logged as warnings at boot — each one has cost somebody an
 * afternoon of wondering why a working feature does nothing.
 */
export function configWarnings(config: Config): string[] {
  const warn: string[] = [];

  if (!config.APP_SECRET) {
    warn.push(
      'APP_SECRET is unset — webhook signatures are NOT verified. Anyone who finds ' +
        'the URL can forge inbound messages and send WhatsApp messages on your bill.',
    );
  }
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_KEY) {
    warn.push('SUPABASE_URL / SUPABASE_SERVICE_KEY unset — no analytics will be recorded.');
  }
  if (!config.CATALOG_ID) {
    warn.push('CATALOG_ID unset — looks fall back to plain images with no product page.');
  }
  if (!config.IND_SHOPIFY_API_SECRET) {
    warn.push('IND_SHOPIFY_API_SECRET unset — the bundled mock catalog will be used.');
  }
  // No Anthropic warning: the free-text stylist was removed in e32e866, and
  // ranking has always been deterministic. Warning about a key nothing reads
  // would send somebody hunting for a feature that is not there.
  if (!config.DASHBOARD_TOKEN) {
    warn.push('DASHBOARD_TOKEN unset — the dashboard route refuses every request.');
  }

  return warn;
}
