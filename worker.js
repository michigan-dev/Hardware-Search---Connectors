// Workers entry point. Cloudflare's git integration deploys this repo as a Worker
// (`npx wrangler deploy`), and Workers ignore the Pages `functions/` file routing,
// so the same handlers are wired up by hand here and everything else falls through
// to the static assets in ./public.
import { onRequestGet as sourcing } from './functions/api/sourcing.js';
import { onRequestGet as health } from './functions/api/health.js';

const ROUTES = { '/api/sourcing': sourcing, '/api/health': health };

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const handler = ROUTES[pathname];
    if (!handler) return env.ASSETS.fetch(request);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    // Build the Pages-style context so one set of handlers serves both targets.
    return handler({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
  },
};
