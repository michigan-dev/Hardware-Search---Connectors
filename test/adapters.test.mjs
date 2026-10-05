// Plain Node, no framework. Feeds each adapter representative payloads through an
// injected fetch. These prove the normalisers behave; they CANNOT prove the field
// names match the live APIs, which needs real keys.
import {
  lookupMouser, lookupDigikey, lookupAll, parsePrice, parseMouserStock, resetTokenCache,
  isCacheable, validQuery, credentialStatus, normaliseMouser, normaliseDigikey,
} from '../lib/distributors.js';
import { onRequestGet as sourcing } from '../functions/api/sourcing.js';
import { onRequestGet as health } from '../functions/api/health.js';
import worker from '../worker.js';

let pass = 0, fail = 0;
async function t(name, fn) {
  resetTokenCache(); // module state must never leak between cases
  try { await fn(); pass++; } catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'mismatch'}\n      got      ${JSON.stringify(a)}\n      expected ${JSON.stringify(b)}`); };

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError('bad json'); return body; } });
const MOUSER_ENV = { MOUSER_API_KEY: 'k' };
const DK_ENV = { DIGIKEY_CLIENT_ID: 'id', DIGIKEY_CLIENT_SECRET: 'secret' };

const mouserPayload = {
  Errors: [],
  SearchResults: { NumberOfResult: 2, Parts: [
    { MouserPartNumber: '999-OTHER', ManufacturerPartNumber: 'OTHER', Manufacturer: 'X', Availability: '5 In Stock', PriceBreaks: [] },
    { MouserPartNumber: '123-DT06-2S', ManufacturerPartNumber: 'DT06-2S', Manufacturer: 'Deutsch', Description: '2 pos plug',
      Availability: '1,234 In Stock', LeadTime: '84 Days', ProductDetailUrl: 'https://www.mouser.com/p/1', DataSheetUrl: 'https://ds/1.pdf',
      PriceBreaks: [{ Quantity: 100, Price: '$1.10', Currency: 'USD' }, { Quantity: 1, Price: '$2.50', Currency: 'USD' }, { Quantity: 10, Price: '$1.234,56 EUR', Currency: 'EUR' }] },
  ] },
};
const digikeyPayload = {
  ProductsCount: 1,
  Products: [{
    Description: { ProductDescription: 'CONN PLUG 2POS' }, Manufacturer: { Name: 'Deutsch' }, ManufacturerProductNumber: 'DT06-2S',
    QuantityAvailable: 900, ProductUrl: 'https://www.digikey.com/p/1', DatasheetUrl: 'https://ds/2.pdf', ManufacturerLeadWeeks: '12',
    ProductVariations: [
      { DigiKeyProductNumber: '1-CT', QuantityAvailableforPackageType: 100, StandardPricing: [{ BreakQuantity: 1, UnitPrice: 3.1 }] },
      { DigiKeyProductNumber: '1-BULK', QuantityAvailableforPackageType: 800, StandardPricing: [{ BreakQuantity: 50, UnitPrice: 1.9 }, { BreakQuantity: 1, UnitPrice: 2.4 }] },
    ],
  }],
};

// ---------------------------------------------------------------- parsePrice
await t('parsePrice accepts plain, currency-prefixed and thousands-separated values', () => {
  eq(parsePrice('$1.23'), 1.23); eq(parsePrice('1,234.50'), 1234.5); eq(parsePrice('USD 0.0042'), 0.0042);
  eq(parsePrice(' €7 '), 7); eq(parsePrice(3.5), 3.5); eq(parsePrice('0'), 0);
});
await t('parsePrice drops corrupted values instead of mangling them', () => {
  for (const bad of ['1.234,56 EUR', '$1.2.3', 'abc', '', '1e3', '$', '--', '12 34', '1,23', null, undefined, NaN, -1, {}, '$-5'])
    eq(parsePrice(bad), null, `should drop ${JSON.stringify(bad)}`);
});
await t('parseMouserStock', () => {
  eq(parseMouserStock('1,234 In Stock'), 1234); eq(parseMouserStock('None'), 0);
  eq(parseMouserStock('On Order'), null); eq(parseMouserStock(undefined), null);
});

// ---------------------------------------------------------------- Mouser
await t('mouser: happy path picks the exact MPN and sorts price breaks', async () => {
  const r = await lookupMouser('DT06-2S', MOUSER_ENV, async () => res(200, mouserPayload));
  eq(r.ok, true); eq(r.part.mpn, 'DT06-2S'); eq(r.part.stock, 1234); eq(r.part.leadTime, '84 Days');
  eq(r.part.priceBreaks, [{ qty: 1, price: 2.5, currency: 'USD' }, { qty: 100, price: 1.1, currency: 'USD' }]); // malformed EUR price dropped
});
await t('mouser: sends key as query parameter and part number in the body', async () => {
  let seen;
  await lookupMouser('DT06-2S', MOUSER_ENV, async (url, init) => { seen = { url, init }; return res(200, mouserPayload); });
  if (!seen.url.includes('/api/v1/search/partnumber?apiKey=k')) throw new Error(seen.url);
  eq(JSON.parse(seen.init.body), { SearchByPartRequest: { mouserPartNumber: 'DT06-2S' } });
  eq(seen.init.method, 'POST');
});
await t('mouser: missing key makes no request', async () => {
  let called = false;
  const r = await lookupMouser('X', {}, async () => { called = true; return res(200, {}); });
  eq(r, { ok: false, reason: 'no_key' }); eq(called, false);
});
await t('mouser: 429 -> rate_limited, 401 -> auth, 500 -> http_error', async () => {
  eq((await lookupMouser('X', MOUSER_ENV, async () => res(429, {}))).reason, 'rate_limited');
  eq((await lookupMouser('X', MOUSER_ENV, async () => res(401, {}))).reason, 'auth');
  eq((await lookupMouser('X', MOUSER_ENV, async () => res(500, {}))).reason, 'http_error');
});
await t('mouser: API-level errors are classified', async () => {
  const mk = (Code, Message) => async () => res(200, { Errors: [{ Code, Message }], SearchResults: null });
  eq((await lookupMouser('X', MOUSER_ENV, mk('TooManyRequests', 'limit'))).reason, 'rate_limited');
  eq((await lookupMouser('X', MOUSER_ENV, mk('InvalidCredentials', 'Invalid unique identifier'))).reason, 'auth');
  eq((await lookupMouser('X', MOUSER_ENV, mk('Other', 'boom'))).reason, 'api_error');
});
await t('mouser: empty result -> not_found', async () => {
  eq((await lookupMouser('X', MOUSER_ENV, async () => res(200, { Errors: [], SearchResults: { NumberOfResult: 0, Parts: [] } }))).reason, 'not_found');
});
await t('mouser: network throw -> network, abort -> timeout', async () => {
  eq((await lookupMouser('X', MOUSER_ENV, async () => { throw new TypeError('fetch failed'); })).reason, 'network');
  eq((await lookupMouser('X', MOUSER_ENV, async () => { throw Object.assign(new Error('t'), { name: 'AbortError' }); })).reason, 'timeout');
});
await t('mouser: non-JSON and wrong-shape bodies -> bad_response', async () => {
  eq((await lookupMouser('X', MOUSER_ENV, async () => res(200, undefined))).reason, 'bad_response');
  eq((await lookupMouser('X', MOUSER_ENV, async () => res(200, { hello: 1 }))).reason, 'bad_response');
});
await t('mouser: sparse part still normalises with nulls', () => {
  const r = normaliseMouser({ Errors: [], SearchResults: { Parts: [{ MouserPartNumber: 'M-1' }] } }, 'M-1');
  eq(r.ok, true); eq(r.part, { sku: 'M-1', mpn: null, manufacturer: null, description: null, stock: null, leadTime: null, priceBreaks: [], url: null, datasheet: null });
});
await t('mouser: part with null entries inside arrays does not throw', () => {
  const r = normaliseMouser({ SearchResults: { Parts: [null, { ManufacturerPartNumber: 'A', PriceBreaks: [null, {}, { Quantity: 'x', Price: 'y' }] }] } }, 'A');
  eq(r.ok, true); eq(r.part.priceBreaks, []);
});

// ---------------------------------------------------------------- DigiKey
function dkFetch({ token = res(200, { access_token: 'tok', expires_in: 600 }), search = res(200, digikeyPayload), log = [] } = {}) {
  return async (url, init) => { log.push({ url, init }); return url.includes('/oauth2/token') ? token : search; };
}
await t('digikey: happy path picks best-stocked variation', async () => {
  const r = await lookupDigikey('DT06-2S', DK_ENV, dkFetch());
  eq(r.ok, true); eq(r.part.sku, '1-BULK'); eq(r.part.stock, 800); eq(r.part.leadTime, '12 weeks');
  eq(r.part.priceBreaks, [{ qty: 1, price: 2.4, currency: 'USD' }, { qty: 50, price: 1.9, currency: 'USD' }]);
  eq(r.part.description, 'CONN PLUG 2POS');
});
await t('digikey: sends OAuth form, bearer token and locale headers', async () => {
  const log = [];
  await lookupDigikey('DT06-2S', DK_ENV, dkFetch({ log }));
  eq(log.length, 2);
  if (!log[0].init.body.includes('grant_type=client_credentials')) throw new Error('token body');
  const h = log[1].init.headers;
  eq([h.Authorization, h['X-DIGIKEY-Client-Id'], h['X-DIGIKEY-Locale-Site']], ['Bearer tok', 'id', 'US']);
  eq(JSON.parse(log[1].init.body).Keywords, 'DT06-2S');
});
await t('digikey: missing credentials make no request', async () => {
  const log = [];
  eq(await lookupDigikey('X', { DIGIKEY_CLIENT_ID: 'id' }, dkFetch({ log })), { ok: false, reason: 'no_key' });
  eq(log.length, 0);
});
await t('digikey: token is cached across calls', async () => {
  const log = [];
  const f = dkFetch({ log });
  await lookupDigikey('A', DK_ENV, f); await lookupDigikey('B', DK_ENV, f);
  eq(log.filter((l) => l.url.includes('/oauth2/token')).length, 1);
});
await t('digikey: resetTokenCache forces a fresh token', async () => {
  const log = [];
  const f = dkFetch({ log });
  await lookupDigikey('A', DK_ENV, f); resetTokenCache(); await lookupDigikey('B', DK_ENV, f);
  eq(log.filter((l) => l.url.includes('/oauth2/token')).length, 2);
});
await t('digikey: token endpoint rejection -> auth, 429 -> rate_limited, no token -> bad_response', async () => {
  eq((await lookupDigikey('X', DK_ENV, dkFetch({ token: res(401, {}) }))).reason, 'auth');
  eq((await lookupDigikey('X', DK_ENV, dkFetch({ token: res(429, {}) }))).reason, 'rate_limited');
  eq((await lookupDigikey('X', DK_ENV, dkFetch({ token: res(200, {}) }))).reason, 'bad_response');
});
await t('digikey: search 401 -> auth AND the stale token is discarded', async () => {
  const log = [];
  const f = dkFetch({ search: res(401, {}), log });
  eq((await lookupDigikey('X', DK_ENV, f)).reason, 'auth');
  await lookupDigikey('X', DK_ENV, f);
  eq(log.filter((l) => l.url.includes('/oauth2/token')).length, 2, 'token should be re-requested after a 401');
});
await t('digikey: search 429 -> rate_limited, 500 -> http_error', async () => {
  eq((await lookupDigikey('X', DK_ENV, dkFetch({ search: res(429, {}) }))).reason, 'rate_limited');
  eq((await lookupDigikey('X', DK_ENV, dkFetch({ search: res(500, {}) }))).reason, 'http_error');
});
await t('digikey: empty and malformed results', async () => {
  eq((await lookupDigikey('X', DK_ENV, dkFetch({ search: res(200, { Products: [] }) }))).reason, 'not_found');
  eq((await lookupDigikey('X', DK_ENV, dkFetch({ search: res(200, { nope: 1 }) }))).reason, 'bad_response');
  eq((await lookupDigikey('X', DK_ENV, dkFetch({ search: res(200, undefined) }))).reason, 'bad_response');
});
await t('digikey: network throw and timeout', async () => {
  eq((await lookupDigikey('X', DK_ENV, async () => { throw new TypeError('down'); })).reason, 'network');
  resetTokenCache();
  eq((await lookupDigikey('X', DK_ENV, async () => { throw Object.assign(new Error('t'), { name: 'AbortError' }); })).reason, 'timeout');
});
await t('digikey: sparse product with no variations falls back to product-level stock', () => {
  const r = normaliseDigikey({ Products: [{ ManufacturerProductNumber: 'A', QuantityAvailable: 7 }] }, 'A');
  eq(r.ok, true); eq(r.part.stock, 7); eq(r.part.sku, null); eq(r.part.priceBreaks, []);
});
await t('digikey: malformed price in a variation is dropped, not mangled', () => {
  const r = normaliseDigikey({ Products: [{ ManufacturerProductNumber: 'A', ProductVariations: [
    { QuantityAvailableforPackageType: 1, StandardPricing: [{ BreakQuantity: 1, UnitPrice: '1.2.3' }, { BreakQuantity: 5, UnitPrice: 0.5 }] }] }] }, 'A');
  eq(r.part.priceBreaks, [{ qty: 5, price: 0.5, currency: 'USD' }]);
});

// ---------------------------------------------------------------- orchestration
await t('lookupAll with zero credentials returns two no_key results with search links', async () => {
  let called = false;
  const r = await lookupAll('ABC 123', {}, async () => { called = true; return res(200, {}); });
  eq(called, false);
  eq([r.results.mouser.reason, r.results.digikey.reason], ['no_key', 'no_key']);
  if (!r.results.mouser.searchUrl.includes('ABC%20123')) throw new Error('search url not encoded');
});
await t('lookupAll: one vendor failing does not affect the other', async () => {
  const f = async (url) => (url.includes('mouser') ? (() => { throw new TypeError('down'); })() : url.includes('/oauth2/token') ? res(200, { access_token: 't' }) : res(200, digikeyPayload));
  const r = await lookupAll('DT06-2S', { ...MOUSER_ENV, ...DK_ENV }, f);
  eq(r.results.mouser.reason, 'network'); eq(r.results.digikey.ok, true);
});
await t('lookupAll: a vendor that rejects still yields a result', async () => {
  const r = await lookupAll('X', { ...MOUSER_ENV, ...DK_ENV }, async () => { throw new Error('everything is on fire'); });
  eq([r.results.mouser.ok, r.results.digikey.ok], [false, false]);
});
await t('isCacheable only for settled outcomes', () => {
  eq(isCacheable({ results: { a: { ok: true }, b: { ok: false, reason: 'not_found' } } }), true);
  eq(isCacheable({ results: { a: { ok: true }, b: { ok: false, reason: 'rate_limited' } } }), false);
  eq(isCacheable({ results: { a: { ok: false, reason: 'timeout' } } }), false);
  eq(isCacheable({ results: { a: { ok: false, reason: 'no_key' } } }), false);
});
await t('validQuery', () => {
  eq([validQuery('DT06-2S'), validQuery('a'), validQuery(''), validQuery('x'.repeat(65)), validQuery('café'), validQuery(null)], [true, false, false, false, false, false]);
});
await t('credentialStatus never leaks values', () => {
  const s = credentialStatus({ MOUSER_API_KEY: 'secret-key', DIGIKEY_CLIENT_ID: 'a' });
  eq(s, { mouser: { configured: true }, digikey: { configured: false } });
  if (JSON.stringify(s).includes('secret')) throw new Error('leak');
});

// ---------------------------------------------------------------- handlers (zero credentials)
const ctx = (url, env = {}) => ({ request: new Request(url), env, waitUntil: () => {} });
await t('GET /api/sourcing with zero credentials runs and degrades', async () => {
  const r = await sourcing(ctx('https://x.test/api/sourcing?q=D38999%2F26WB35SN'));
  eq(r.status, 200);
  const b = await r.json();
  eq([b.results.mouser.reason, b.results.digikey.reason], ['no_key', 'no_key']);
});
await t('GET /api/sourcing rejects a missing or oversized query', async () => {
  eq((await sourcing(ctx('https://x.test/api/sourcing'))).status, 400);
  eq((await sourcing(ctx('https://x.test/api/sourcing?q=' + 'a'.repeat(100)))).status, 400);
});
await t('GET /api/health reports presence only', async () => {
  const b = await (await health({ env: { MOUSER_API_KEY: 'shh' } })).json();
  eq(b, { ok: true, mouser: { configured: true }, digikey: { configured: false } });
});
await t('worker.js routes API paths to handlers and everything else to ASSETS', async () => {
  const env = { ASSETS: { fetch: async () => new Response('asset') } };
  const c = { waitUntil() {} };
  eq(await (await worker.fetch(new Request('https://x.test/'), env, c)).text(), 'asset');
  eq((await worker.fetch(new Request('https://x.test/api/health'), env, c)).status, 200);
  eq((await worker.fetch(new Request('https://x.test/api/sourcing?q=ab'), env, c)).status, 200);
  eq((await worker.fetch(new Request('https://x.test/api/sourcing?q=ab', { method: 'POST' }), env, c)).status, 405);
});

console.log(`adapter tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
