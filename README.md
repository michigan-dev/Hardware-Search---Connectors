# Harness Decoder

Paste a wire or connector part number. The tool splits it into fields, explains each
one, and checks Mouser and DigiKey for stock and price. It is aimed at harness
engineers in aerospace, defense and automotive.

> **Verify before trusting.** The lookup tables were transcribed from memory, not
> from the controlling specifications. Values the author was unsure of carry a
> visible **VERIFY** badge, but an unbadged value is not a guarantee. Check anything
> that matters against MIL-DTL-38999, MIL-DTL-5015, M22759 and the other specs, or
> the manufacturer's drawing. All tables sit in one block at the top of the inline
> script in `public/index.html` so they can be corrected in one place.

## The core idea: identification and sourcing are decoupled

No lookup table will ever cover every part number, so the tool never depends on one.

| Tier | Meaning | What you see |
|---|---|---|
| **Full** | A parser exists | Every field bracketed and explained, linked to its card |
| **Family only** | The signature matches, no parser | The family, and a note on what the part is |
| **None** | No signature matches | A plain statement that it is not recognised |

All three tiers still run the distributor lookup, on the raw string you typed. An
unrecognised part number returns Mouser and DigiKey results rather than a dead end.
`plan()` in the decoder block enforces this, and `test/decode.test.mjs` checks it.

There is no industry dropdown. The family is detected from the string. The select
next to the input is an override and defaults to `auto`.

## Honesty rules the decoder follows

- No contact counts are derived from insert arrangement codes. That needs the
  manufacturer's arrangement chart, and the note says so.
- Pin/socket gender is only stated where a letter really encodes it (D38999 `P`/`S`,
  MS31xx `P`/`S`, Deutsch `S`/`P`). On M83513 and M39029 it comes from the slash
  sheet, and the notes say that.
- Wire gauge dimensions are computed from the AWG definition, not typed in.
- A parser that cannot split a string degrades to the family tier with a message. It
  never throws.

## Adding a signature

The registry is one ordered array in `public/index.html`, most specific first, first
match wins:

```js
{ id:'d38999', ind:IND.aero, fam:'MIL-DTL-38999 circular (Series I–IV)',
  re:/^(D|M)?38999/, parse:p38999, ref:['shell_38999'] }
```

- **Family only:** add an entry with `id`, `ind`, `fam`, `re` and a `note`. The note is
  required when there is no `parse`; say something an engineer would want to know.
- **Full decode:** also write a `parse(normalisedString)` function that returns
  `{ segments }` or `{ error }` (plus optional `wire` for a striped-wire drawing). A
  segment is `{ text, label, title, note, verify }`. Segments with `label: null` are
  separators. Segment texts must concatenate back to the input; the decoder rejects a
  parser that does not.
- Input is upper-cased and stripped of whitespace before matching.
- Regexes must not use the `g` or `y` flags.

`npm test` checks registry hygiene: unique ids, industry and family present, a note on
every parser-less entry.

## Distributor sourcing

Mouser and DigiKey only. TTI is deliberately left out: its API sits behind a sales
relationship and the docs are not publicly reachable, so an adapter would be guesswork.

Normalised shape from both:

```
{ ok, reason?, part: { sku, mpn, manufacturer, description, stock, leadTime,
                       priceBreaks: [{ qty, price, currency }], url, datasheet } }
```

Failure reasons the UI distinguishes: `no_key`, `rate_limited`, `auth`, `timeout`,
`not_found`, plus `http_error`, `api_error`, `network` and `bad_response`.

### Credentials

Everything works with none configured. Each vendor card degrades to a search link,
which is the default deployment state and is covered by tests.

| Variable | Where to get it |
|---|---|
| `MOUSER_API_KEY` | Mouser Search API key from the Mouser API hub |
| `DIGIKEY_CLIENT_ID`, `DIGIKEY_CLIENT_SECRET` | A DigiKey developer app with the Product Information v4 API (two-legged OAuth) |
| `DIGIKEY_API_BASE` (optional) | Set to the DigiKey sandbox host while testing |

`GET /api/health` reports which of these the deployment can see, as booleans only.

### Behaviour worth knowing

- Results are cached for about 10 minutes (edge Cache API on Workers, a bounded `Map`
  on Node). Failures such as timeouts and rate limits are not cached.
- DigiKey's standard app allows roughly 120 requests/min and 1000/day, hence the cache.
- One vendor failing never affects the other (`Promise.allSettled`).
- Prices are parsed strictly. Anything that does not look like a price is dropped,
  never "repaired" by stripping characters.
- The DigiKey token cache is resettable (`resetTokenCache()`), so tests can exercise
  the 401 and 429 branches instead of being masked by a cached token.

## Deployment

### 1. Cloudflare (git integration, Workers)

Cloudflare's git integration deploys a repository as a **Worker** with
`npx wrangler deploy`. Workers ignore the Pages `functions/` routing, so `worker.js`
routes `/api/sourcing` and `/api/health` to the same handlers and falls through to
`env.ASSETS` for everything else. `wrangler.jsonc` points `main` at `worker.js` and
`assets.directory` at `./public`.

Set secrets with `npx wrangler secret put MOUSER_API_KEY` (and the DigiKey pair), or in
the dashboard. If the build says "Could not detect a directory containing static
files", `wrangler.jsonc` is missing from the repo root. If it names a missing path,
the `public/` folder was not committed.

Cloudflare Pages also works unchanged: `functions/api/*.js` export `onRequestGet`.

### 2. Any Node host

```
npm install
npm start          # http://localhost:8787
```

or with Docker:

```
docker build -t harness-decoder .
docker run -p 8787:8787 -e MOUSER_API_KEY=... harness-decoder
```

`server.js` is a deliberate port of the Workers handlers: secrets from `process.env`,
an in-process cache, static files served by Express. Fixing a bug in one means checking
the other.

### 3. GitLab Pages (static only)

`.gitlab-ci.yml` runs the tests and publishes `public/` as-is. There is no API there, so
every vendor card shows a search link. CI needs no install step because the tests
import only Node builtins.

## Tests

```
npm test        # decoder + adapters
npm run check   # syntax check every entry point, then tests
```

Plain Node scripts, no framework.

- `test/decode.test.mjs` extracts the decoder block from `index.html` and checks
  detection (including negatives), exact field-label sequences, malformed input that must
  degrade rather than throw, and registry hygiene.
- `test/adapters.test.mjs` feeds both adapters representative payloads through an
  injected `fetch`: happy path, missing credentials, HTTP errors, API-level errors, empty
  results, network throws, sparse payloads and a deliberately malformed price.

**What the tests cannot show:** that the field names match the live Mouser and DigiKey
responses. The payloads are modelled on the public documentation as remembered at build
time and were not checked against real responses. That needs real keys.

## Not verified

- Live Mouser and DigiKey request and response field names (no keys were available).
- Most code meanings in the decoder tables, hence the VERIFY badges and the warning
  above. Slash-sheet numbers, finish letters, class letters and keying codes especially.
- The GitLab Pages job against a real GitLab instance.
- `npm run check`, the dry-run deploy (`npx wrangler deploy --dry-run`) and a local
  Express run were exercised; a real Cloudflare deploy was not.

## Layout

```
public/index.html          the whole decoder, self-contained, no build step
functions/api/sourcing.js  Mouser + DigiKey proxy (Pages Function / Workers handler)
functions/api/health.js    credential status
lib/distributors.js        shared adapters, price parsing, token cache
worker.js                  Workers entry: routes the API paths, else ASSETS
wrangler.jsonc             main: worker.js, assets.directory: ./public
server.js                  Express equivalent for Node hosts
test/                      decode.test.mjs, adapters.test.mjs
```

MIT licensed.
