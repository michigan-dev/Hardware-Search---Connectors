// Express host for plain Node deployments (Docker, a VM, Render, Fly, ...).
//
// A deliberate port of functions/api/*.js, not a copy: secrets come from
// process.env rather than Worker bindings, there is no edge Cache API so results
// live in a bounded in-process Map, and static files are served here instead of by
// the Workers assets binding. Fixing a bug in one means checking the other.
import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lookupAll, validQuery, isCacheable, credentialStatus, CACHE_SECONDS } from './lib/distributors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_ENTRIES = 500;
const cache = new Map(); // key -> { expires, payload }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

function cacheSet(key, payload) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value); // oldest first
  cache.set(key, { expires: Date.now() + CACHE_SECONDS * 1000, payload });
}

export function createApp(env = process.env) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, ...credentialStatus(env) });
  });

  app.get('/api/sourcing', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    res.set('Cache-Control', 'no-store');
    if (!validQuery(q)) return res.status(400).json({ error: 'q must be 2-64 printable ASCII characters' });

    const key = q.toUpperCase();
    const hit = cacheGet(key);
    if (hit) return res.json({ ...hit, cached: true });

    const payload = await lookupAll(q, env);
    if (isCacheable(payload)) cacheSet(key, payload);
    res.json({ ...payload, cached: false });
  });

  app.use(express.static(path.join(here, 'public')));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8787;
  createApp().listen(port, () => console.log(`Harness Decoder on http://localhost:${port}`));
}
