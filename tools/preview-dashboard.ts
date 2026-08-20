/**
 * Renders the dashboard to a static file using the bundled sample data.
 *
 * Run it with `npm run dashboard:preview`. It goes through the real section
 * modules, so what you open is what the Worker serves — the only difference is
 * where the numbers came from. No Supabase, no deploy, no token.
 *
 * Useful for working on the page itself, and for showing somebody the report
 * before there is any traffic to fill it.
 */

import { renderPage } from '../src/dashboard/page.js';
import type { DashboardData } from '../src/dashboard/queries.js';
import sample from '../docs/dashboard-sample.json';

const html = renderPage(sample as unknown as DashboardData, {
  token: 'preview',
  apiBase: '/dashboard/api',
  days: 30,
  phone: '',
  // Stamps "Sample data — not connected" in the sidebar, so a screenshot of
  // this can never be mistaken for real trading figures.
  live: false,
});

process.stdout.write(html);
