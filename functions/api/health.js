// GET /api/health: which credentials this deployment can see. Never returns values.
import { credentialStatus } from '../../lib/distributors.js';

export async function onRequestGet({ env }) {
  return new Response(JSON.stringify({ ok: true, ...credentialStatus(env) }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
