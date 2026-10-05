// Cloudflare Pages Function / Workers handler: GET /api/sourcing?q=<part number>
//
// Express twin: server.js. They share lib/distributors.js but differ in how they
// reach secrets (env bindings vs process.env) and in caching (edge Cache API vs
// an in-process Map). Fixing a bug in one means checking the other.
import { lookupAll, validQuery, isCacheable, CACHE_SECONDS } from '../../lib/distributors.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export async function onRequestGet({ request, env, waitUntil }) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (!validQuery(q)) {
    return json({ error: 'q must be 2-64 printable ASCII characters' }, 400, { 'Cache-Control': 'no-store' });
  }

  // Normalise the cache key so "abc" and "ABC " share an entry, and so unrelated
  // query-string noise cannot fragment it.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`https://cache.invalid/api/sourcing?q=${encodeURIComponent(q.toUpperCase())}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.json();
      return json({ ...body, cached: true }, 200, { 'Cache-Control': 'no-store' });
    }
  }

  const payload = await lookupAll(q, env);
  const res = json({ ...payload, cached: false }, 200, { 'Cache-Control': 'no-store' });

  if (cache && isCacheable(payload)) {
    const stored = new Response(JSON.stringify(payload), {
      headers: { ...JSON_HEADERS, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
    });
    const write = cache.put(cacheKey, stored);
    if (waitUntil) waitUntil(write);
    else await write;
  }
  return res;
}
