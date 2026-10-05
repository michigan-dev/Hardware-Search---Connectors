// Plain Node, no framework. Extracts the inline decoder from public/index.html
// and exercises it. Run: node test/decode.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html'), 'utf8');
const m = /\/\* DECODER:START[^\n]*\n([\s\S]*?)\/\* DECODER:END \*\//.exec(html);
if (!m) throw new Error('DECODER markers not found in public/index.html');
const { decode, plan, REGISTRY, normalize } = new Function(`${m[1]}\nreturn { decode, plan, REGISTRY, normalize };`)();

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'mismatch'}\n      got      ${JSON.stringify(a)}\n      expected ${JSON.stringify(b)}`); };
const labels = (r) => r.segments.filter((s) => s.label !== null).map((s) => s.label);

// ---- detection: [input, expected id | null, expected tier]
const detect = [
  ['D38999/26WB35SN', 'd38999', 'full'],
  ['M38999/26WB35SN', 'd38999', 'full'],
  ['d38999/26wb35sn', 'd38999', 'full'],           // case-insensitive
  [' D38999 / 26WB35SN ', 'd38999', 'full'],        // stray whitespace
  ['D38999/XX', 'd38999', 'family'],                // family known, fields not splittable
  ['MS27472E12B35S', 'ms38999', 'family'],
  ['MS3106A18-1P', 'ms5015', 'full'],
  ['MS3102A-20-29S', 'ms5015', 'full'],
  ['M83513/01-A01N', 'm83513', 'full'],
  ['M39029/58-360', 'm39029', 'full'],
  ['M85049/52-3-12W', 'm85049', 'full'],
  ['M22759/11-20-9', 'm22759', 'full'],
  ['M27500-22TG2T14', 'm27500', 'full'],
  ['DT06-2S', 'deutsch-dt', 'full'],
  ['DTM04-12PA', 'deutsch-dt', 'full'],
  ['DTP06-4S-E005', 'deutsch-dt', 'full'],
  ['TXL-16-BLK/WHT', 'j1128', 'full'],
  ['GXL18RED', 'j1128', 'full'],
  ['FLRY-B0.5BU/WH', 'iso6722', 'full'],
  ['M83723/71R1415N', 'm83723', 'family'],
  ['PT06A-14-19P', 'm26482', 'family'],
  ['M24308/2-1', 'm24308', 'family'],
  ['HD10-9-1939P', 'deutsch-hd', 'family'],
  ['776262-1', 'ampseal', 'family'],
  ['282080-1', 'superseal', 'family'],
  ['43025-0600', 'microfit', 'family'],
  ['PHR-2', 'jst', 'family'],
  ['Han 16B', 'han', 'family'],
  ['M12-A-4P', 'm12m8', 'family'],
  ['DF13-6S-1.25C', 'hirose-df', 'family'],
  // negatives: must not match anything
  ['XYZ-123-UNKNOWN', null, 'none'],
  ['HELLO', null, 'none'],
  ['M12', null, 'none'],            // bare, could be a bolt
  ['HAND-TOOL', null, 'none'],      // must not be read as Han D
  ['', null, 'none'],
  ['   ', null, 'none'],
];
for (const [input, id, tier] of detect) {
  t(`detect ${JSON.stringify(input)}`, () => {
    const r = decode(input);
    eq(r.sig && r.sig.id, id, 'family id');
    eq(r.tier, tier, 'tier');
  });
}

// ---- parser output: exact field-label sequences
const sequences = [
  ['D38999/26WB35SN', ['Prefix', 'Spec', 'Slash sheet', 'Finish', 'Shell size', 'Arrangement', 'Contacts', 'Keying']],
  ['MS3106A18-1P', ['Style', 'Class', 'Shell size', 'Arrangement', 'Contacts']],
  ['M83513/01-A01N', ['Spec', 'Slash sheet', 'Arrangement', 'Option', 'Class']],
  ['M39029/58-360', ['Spec', 'Slash sheet', 'Dash no.']],
  ['M85049/52-3-12W', ['Spec', 'Slash sheet', 'Variant', 'Size', 'Finish']],
  ['M85049/38-12N', ['Spec', 'Slash sheet', 'Size', 'Finish']],
  ['M22759/11-20-9', ['Spec', 'Slash sheet', 'Gauge', 'Colour']],
  ['M27500-22TG2T14', ['Spec', 'Gauge', 'Wire type', 'Conductors', 'Shield', 'Jacket']],
  ['DT06-2S', ['Series', 'Housing', 'Cavities', 'Contacts']],
  ['DTM06-12SA-E003', ['Series', 'Housing', 'Cavities', 'Contacts', 'Keying', 'Modifier']],
  ['TXL-16-BLK/WHT', ['Type', 'Gauge', 'Base colour', 'Tracer']],
  ['GXL18', ['Type', 'Gauge']],
  ['FLRY-B0.5BU/WH', ['Type', 'Wall class', 'Section', 'Base colour', 'Tracer']],
  ['FLR2X-0.35GN', ['Type', 'Section', 'Base colour']],
];
for (const [input, want] of sequences) {
  t(`labels ${input}`, () => {
    const r = decode(input);
    eq(r.tier, 'full', 'tier');
    eq(labels(r), want);
    eq(r.segments.map((s) => s.text).join(''), normalize(input), 'segments must rebuild the input');
  });
}

// ---- specific semantics
t('M22759 colour 95 is white with a green stripe', () => {
  const r = decode('M22759/11-20-95');
  eq(r.wire.base, '#f2f0e6'); eq(r.wire.stripes, ['#2e9e4f']);
});
t('M22759 solid colour has no stripes', () => eq(decode('M22759/11-20-9').wire.stripes, []));
t('J1128 colour pair yields a striped wire', () => {
  const r = decode('TXL-16-BLK/WHT');
  eq(r.wire.base, '#1a1a1a'); eq(r.wire.stripes, ['#f2f0e6']);
});
t('unknown colour abbreviation is flagged, not guessed', () => {
  const r = decode('TXL-16-QQQ');
  eq(r.tier, 'full'); eq(r.wire, null);
  eq(r.segments.find((s) => s.label === 'Base colour').verify, true);
});
t('D38999 never states a contact count', () => {
  const r = decode('D38999/26WB35SN');
  const arr = r.segments.find((s) => s.label === 'Arrangement');
  if (/\b\d+\s*(contacts|pins|positions)\b/i.test(arr.title)) throw new Error('arrangement title derives a count');
  if (!/chart/i.test(arr.note)) throw new Error('note should point at the arrangement chart');
});
t('M83513 does not assert gender from the arrangement letter', () => {
  const r = decode('M83513/01-A01N');
  const text = r.segments.map((s) => `${s.title} ${s.note}`).join(' ');
  if (/\b(pin|socket|male|female)s?\s+(connector|contacts)\b.*arrangement letter/i.test(text)) throw new Error('gender asserted');
  const sl = r.segments.find((s) => s.label === 'Slash sheet');
  if (!/slash sheet/i.test(sl.note) || !/gender/i.test(sl.note)) throw new Error('slash sheet note should say gender comes from the slash sheet');
});
t('DT06 with P contacts is flagged as unusual', () => {
  eq(decode('DT06-2P').segments.find((s) => s.label === 'Contacts').verify, true);
});
t('AWG dimensions are computed (AWG 22 ≈ 0.644 mm)', () => {
  const g = decode('M22759/11-22-9').segments.find((s) => s.label === 'Gauge');
  if (!g.title.includes('0.644')) throw new Error(g.title);
});
t('override forces a family and degrades when the string does not fit', () => {
  const r = decode('NOT-A-PART', 'd38999');
  eq(r.sig.id, 'd38999'); eq(r.tier, 'family'); if (!r.error) throw new Error('expected a parse error');
});
t('override pointing at an unknown id yields tier none', () => eq(decode('X1', 'nope').tier, 'none'));

// ---- degradation: malformed input must never throw
const nasty = ['D38999/', 'D38999/26', 'MS3106', 'M22759/', 'M22759/11-20', 'M27500-', 'DT06-', 'TXL-', 'FLRY-', 'D38999/26WB99999SN',
  '\u0000\u0001', '💥', 'M'.repeat(5000), '/////', '-', '38999', 'M22759/999-99-999'];
for (const input of nasty) {
  t(`no throw ${JSON.stringify(input.slice(0, 24))}`, () => {
    const r = decode(input);
    if (!['full', 'family', 'none'].includes(r.tier)) throw new Error('bad tier');
  });
}
t('decode tolerates non-string input', () => { decode(null); decode(undefined); decode(42); decode({}); });

// ---- the sourcing contract: every tier reaches the distributor lookup
t('plan(): unrecognised input still produces a lookup query', () => {
  const p = plan('  XYZ-123-UNKNOWN ');
  eq(p.decode.tier, 'none'); eq(p.lookupQuery, 'XYZ-123-UNKNOWN');
});
t('plan(): family-only input produces a lookup query', () => eq(plan('PHR-2').lookupQuery, 'PHR-2'));
t('plan(): full decode produces a lookup query on the raw string', () => eq(plan('d38999/26wb35sn').lookupQuery, 'd38999/26wb35sn'));
t('plan(): empty input produces no query', () => eq(plan('  ').lookupQuery, null));
t('page runs the lookup for every tier (no early return before it)', () => {
  const run = /function run\(\) \{[\s\S]*?\n  \}/.exec(html)[0].replace(/\/\/.*$/gm, '');
  if (!/if \(p\.lookupQuery\) lookup\(/.test(run)) throw new Error('run() must call lookup based on lookupQuery only');
  if (/tier/.test(run)) throw new Error('run() must not branch on decode tier');
});

// ---- registry hygiene
t('registry ids are unique', () => {
  const ids = REGISTRY.map((s) => s.id);
  eq(new Set(ids).size, ids.length, 'duplicate id');
});
t('every signature has industry, family and a regex', () => {
  for (const s of REGISTRY) {
    if (!s.id || !s.ind || !s.fam || !(s.re instanceof RegExp)) throw new Error(`incomplete: ${s.id}`);
    if (s.re.global || s.re.sticky) throw new Error(`${s.id}: regex must not be global/sticky (lastIndex state)`);
  }
});
t('every parser-less signature has a note', () => {
  for (const s of REGISTRY) if (!s.parse && !(s.note && s.note.length > 20)) throw new Error(`no note: ${s.id}`);
});
t('registry covers about 30 signatures across three industries', () => {
  if (REGISTRY.length < 30) throw new Error(`only ${REGISTRY.length}`);
  eq(new Set(REGISTRY.map((s) => s.ind)).size, 3);
});
t('every ref key resolves', () => {
  for (const s of REGISTRY) for (const k of s.ref || []) {
    const r = decode(s.id === 'd38999' ? 'D38999/26WB35SN' : 'M22759/11-20-9', s.id).refs;
    if (!Array.isArray(r)) throw new Error(k);
  }
});

console.log(`decode tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
