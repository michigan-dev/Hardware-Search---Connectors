// Mouser + DigiKey adapters, shared by the Workers entry, the Pages Function and
// the Express server. Runtime-neutral: no Node or Workers globals except `fetch`,
// and even that is injected so the normalisers can be tested without a network.
//
// NOT VERIFIED AGAINST THE LIVE APIS. The field names below follow the public
// docs as remembered at build time. They need a real key to confirm.
//
// Every adapter resolves to one shape and never throws:
//   { ok: true,  part: { sku, mpn, manufacturer, description, stock, leadTime,
//                        priceBreaks: [{ qty, price, currency }], url, datasheet } }
//   { ok: false, reason: 'no_key' | 'rate_limited' | 'auth' | 'timeout' |
//                        'not_found' | 'http_error' | 'api_error' | 'network' |
//                        'bad_response' }

export const REASONS = [
  'no_key', 'rate_limited', 'auth', 'timeout', 'not_found',
  'http_error', 'api_error', 'network', 'bad_response',
];

const TIMEOUT_MS = 8000;

// ---------------------------------------------------------------- price parsing

// Strict on purpose. The tempting version, String(p).replace(/[^0-9.]/g, ''),
// turns a corrupted value like "1.234,56 EUR" or "$1.2.3" into a plausible wrong
// number. Here anything that is not clearly a price becomes null and is dropped.
const PRICE_RE = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?$/;

export function parsePrice(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/^(?:USD|EUR|GBP|[$€£])\s*/i, '').replace(/\s*(?:USD|EUR|GBP)$/i, '');
  if (!PRICE_RE.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseQty(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/,/g, ''));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanBreaks(list) {
  return list
    .filter((b) => b && b.qty !== null && b.price !== null)
    .sort((a, b) => a.qty - b.qty);
}

// ---------------------------------------------------------------- shared plumbing

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function reasonFromStatus(status) {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  return 'http_error';
}

function reasonFromThrown(err) {
  const name = err && err.name;
  return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network';
}

// fetch with a hard timeout. `fetchImpl` receives the AbortSignal in init.
async function timedFetch(fetchImpl, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function sameMpn(a, b) {
  return typeof a === 'string' && a.replace(/\s+/g, '').toUpperCase() === b.replace(/\s+/g, '').toUpperCase();
}

// ---------------------------------------------------------------- Mouser

// Mouser Search API v1: POST /api/v1/search/partnumber?apiKey=KEY
// Availability and prices arrive as display strings ("1,234 In Stock", "$1.23").
export function parseMouserStock(availability) {
  if (typeof availability !== 'string') return null;
  const s = availability.trim();
  if (/^none$/i.test(s)) return 0;
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)\s+in stock/i.exec(s);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export function normaliseMouser(json, query) {
  const errors = json && json.Errors;
  if (Array.isArray(errors) && errors.length) {
    const text = errors.map((e) => `${e && e.Code} ${e && e.Message}`).join(' ');
    if (/too ?many|rate|limit/i.test(text)) return { ok: false, reason: 'rate_limited' };
    if (/invalid|unauthori[sz]ed|api ?key|credential/i.test(text)) return { ok: false, reason: 'auth' };
    return { ok: false, reason: 'api_error' };
  }
  const parts = json && json.SearchResults && json.SearchResults.Parts;
  if (!Array.isArray(parts)) return { ok: false, reason: 'bad_response' };
  if (parts.length === 0) return { ok: false, reason: 'not_found' };

  const p = parts.find((x) => x && (sameMpn(x.ManufacturerPartNumber, query) || sameMpn(x.MouserPartNumber, query))) || parts[0];
  const breaks = Array.isArray(p.PriceBreaks)
    ? p.PriceBreaks.map((b) => ({
        qty: parseQty(b && b.Quantity),
        price: parsePrice(b && b.Price),
        currency: str(b && b.Currency),
      }))
    : [];

  return {
    ok: true,
    part: {
      sku: str(p.MouserPartNumber),
      mpn: str(p.ManufacturerPartNumber),
      manufacturer: str(p.Manufacturer),
      description: str(p.Description),
      stock: parseMouserStock(p.Availability),
      leadTime: str(p.LeadTime),
      priceBreaks: cleanBreaks(breaks),
      url: str(p.ProductDetailUrl),
      datasheet: str(p.DataSheetUrl),
    },
  };
}

export async function lookupMouser(query, env, fetchImpl = fetch) {
  const key = env && env.MOUSER_API_KEY;
  if (!key) return { ok: false, reason: 'no_key' };
  try {
    const res = await timedFetch(
      fetchImpl,
      `https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: query } }),
      },
    );
    if (!res.ok) return { ok: false, reason: reasonFromStatus(res.status) };
    const json = await readJson(res);
    if (json === undefined) return { ok: false, reason: 'bad_response' };
    return normaliseMouser(json, query);
  } catch (err) {
    return { ok: false, reason: reasonFromThrown(err) };
  }
}

// ---------------------------------------------------------------- DigiKey

// Product Information v4. Two-legged OAuth (client credentials), then
// POST /products/v4/search/keyword. Purchasable SKUs nest under ProductVariations.
//
// The token cache is module state, so it MUST be resettable: otherwise a token
// from one test leaks into the next and silently masks the 401 / 429 branches.
let tokenCache = null; // { token, expires } | null

export function resetTokenCache() {
  tokenCache = null;
}

function digikeyBase(env) {
  return (env && env.DIGIKEY_API_BASE) || 'https://api.digikey.com';
}

async function digikeyToken(env, fetchImpl) {
  if (tokenCache && tokenCache.expires > Date.now()) return { token: tokenCache.token };
  const res = await timedFetch(fetchImpl, `${digikeyBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DIGIKEY_CLIENT_ID,
      client_secret: env.DIGIKEY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }).toString(),
  });
  if (!res.ok) {
    // A rejected credential pair is an auth problem, whatever the status says.
    const reason = res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'http_error' : 'auth';
    return { reason };
  }
  const json = await readJson(res);
  const token = json && str(json.access_token);
  if (!token) return { reason: 'bad_response' };
  const ttl = Number.isFinite(json.expires_in) ? json.expires_in : 600;
  // Renew a minute early so a token never expires mid-request.
  tokenCache = { token, expires: Date.now() + Math.max(ttl - 60, 0) * 1000 };
  return { token };
}

export function normaliseDigikey(json, query) {
  const products = json && json.Products;
  if (!Array.isArray(products)) return { ok: false, reason: 'bad_response' };
  if (products.length === 0) return { ok: false, reason: 'not_found' };

  const p = products.find((x) => x && sameMpn(x.ManufacturerProductNumber, query)) || products[0];
  const variations = Array.isArray(p.ProductVariations) ? p.ProductVariations.filter(Boolean) : [];
  const stockOf = (v) => (Number.isInteger(v.QuantityAvailableforPackageType) ? v.QuantityAvailableforPackageType : -1);
  const best = variations.reduce((a, b) => (a && stockOf(a) >= stockOf(b) ? a : b), null);

  const breaks = best && Array.isArray(best.StandardPricing)
    ? best.StandardPricing.map((b) => ({
        qty: parseQty(b && b.BreakQuantity),
        price: parsePrice(b && b.UnitPrice),
        currency: 'USD',
      }))
    : [];

  const stock = best && stockOf(best) >= 0
    ? stockOf(best)
    : Number.isInteger(p.QuantityAvailable) ? p.QuantityAvailable : null;
  const weeks = str(p.ManufacturerLeadWeeks);

  return {
    ok: true,
    part: {
      sku: str(best && best.DigiKeyProductNumber),
      mpn: str(p.ManufacturerProductNumber),
      manufacturer: str(p.Manufacturer && p.Manufacturer.Name),
      description: str(p.Description && (p.Description.ProductDescription || p.Description.DetailedDescription)),
      stock,
      leadTime: weeks ? `${weeks} weeks` : null,
      priceBreaks: cleanBreaks(breaks),
      url: str(p.ProductUrl),
      datasheet: str(p.DatasheetUrl),
    },
  };
}

export async function lookupDigikey(query, env, fetchImpl = fetch) {
  if (!env || !env.DIGIKEY_CLIENT_ID || !env.DIGIKEY_CLIENT_SECRET) return { ok: false, reason: 'no_key' };
  try {
    const tok = await digikeyToken(env, fetchImpl);
    if (!tok.token) return { ok: false, reason: tok.reason };
    const res = await timedFetch(fetchImpl, `${digikeyBase(env)}/products/v4/search/keyword`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tok.token}`,
        'X-DIGIKEY-Client-Id': env.DIGIKEY_CLIENT_ID,
        'X-DIGIKEY-Locale-Site': 'US',
        'X-DIGIKEY-Locale-Language': 'en',
        'X-DIGIKEY-Locale-Currency': 'USD',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ Keywords: query, Limit: 5, Offset: 0 }),
    });
    if (!res.ok) {
      // A rejected token must not be reused on the next request.
      if (res.status === 401 || res.status === 403) resetTokenCache();
      return { ok: false, reason: reasonFromStatus(res.status) };
    }
    const json = await readJson(res);
    if (json === undefined) return { ok: false, reason: 'bad_response' };
    return normaliseDigikey(json, query);
  } catch (err) {
    return { ok: false, reason: reasonFromThrown(err) };
  }
}

// ---------------------------------------------------------------- orchestration

export function searchLinks(query) {
  const q = encodeURIComponent(query);
  return {
    mouser: `https://www.mouser.com/c/?q=${q}`,
    digikey: `https://www.digikey.com/en/products/result?keywords=${q}`,
  };
}

// Accepts printable ASCII only, 2..64 chars. Part numbers need nothing else, and
// it keeps junk out of upstream requests and cache keys.
export function validQuery(q) {
  return typeof q === 'string' && q.length >= 2 && q.length <= 64 && /^[\x20-\x7e]+$/.test(q.trim());
}

// allSettled so that one distributor throwing, timing out, rate-limiting or being
// unconfigured can never take the other, or the page, down.
export async function lookupAll(query, env, fetchImpl = fetch) {
  const [m, d] = await Promise.allSettled([
    lookupMouser(query, env, fetchImpl),
    lookupDigikey(query, env, fetchImpl),
  ]);
  const settle = (r) => (r.status === 'fulfilled' ? r.value : { ok: false, reason: 'network' });
  const links = searchLinks(query);
  return {
    q: query,
    results: {
      mouser: { ...settle(m), searchUrl: links.mouser },
      digikey: { ...settle(d), searchUrl: links.digikey },
    },
  };
}

// Transient failures are not worth remembering for ten minutes.
export function isCacheable(payload) {
  return Object.values(payload.results).every(
    (r) => r.ok || r.reason === 'not_found',
  );
}

export const CACHE_SECONDS = 600;

// Keys are never echoed, only whether they are present.
export function credentialStatus(env) {
  return {
    mouser: { configured: Boolean(env && env.MOUSER_API_KEY) },
    digikey: { configured: Boolean(env && env.DIGIKEY_CLIENT_ID && env.DIGIKEY_CLIENT_SECRET) },
  };
}
