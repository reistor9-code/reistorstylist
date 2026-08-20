/**
 * Proxies /dashboard/* through to the Worker.
 *
 * The app calls /dashboard/api as a relative URL. In `npm run dev` Vite's
 * proxy handles that; on Pages nothing does, so the request hits the static
 * site, gets index.html back from the SPA fallback, and the app fails with
 * "Unexpected token '<'".
 *
 * Proxying here rather than pointing the app at the Worker's absolute URL is
 * deliberate: the dashboard token stays same-origin, so it is never sent
 * cross-site and the Worker needs no CORS headers — which would otherwise
 * have to name this origin and be kept in step with it.
 *
 * Override the target per environment with DASHBOARD_WORKER in the Pages
 * project's variables.
 */

interface Env {
  DASHBOARD_WORKER?: string;
}

const DEFAULT_WORKER = 'https://reistor-ai-stylist.reistorlife.workers.dev';

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const incoming = new URL(request.url);
  const target = new URL(
    incoming.pathname + incoming.search,
    env.DASHBOARD_WORKER || DEFAULT_WORKER,
  );

  /*
   * The body is forwarded so the one write — marking a callback handled —
   * works too. `redirect: 'manual'` keeps a redirect from the Worker visible
   * to the caller rather than being followed here and losing the status.
   */
  const response = await fetch(
    new Request(target, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    }),
  );

  // Aggregates over a shared inbox: never let an edge cache hold them.
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
