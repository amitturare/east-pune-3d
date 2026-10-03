// Live facts from Wikipedia and Wikidata (both allow anonymous CORS requests).
const cache = new Map();
const LS_KEY = 'pune3d-facts-v1';
let store = {};
try { store = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch {}
const persist = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch {} };

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'Api-User-Agent': 'pune-east-3d (github.com/amitturare/5.5-map)' } });
  if (!res.ok) throw new Error(res.status);
  return res.json();
}
function memo(key, fn) {
  if (store[key] && Date.now() - store[key].t < 7 * 864e5) return Promise.resolve(store[key].v);
  if (!cache.has(key))
    cache.set(key, fn().then((v) => { store[key] = { t: Date.now(), v }; persist(); return v; }).catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

export function wikiSummary(title) {
  return memo('s:' + title, async () => {
    const j = await getJSON(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
    return { title: j.title, extract: j.extract, thumb: j.thumbnail?.source || null, image: j.originalimage?.source || null, url: j.content_urls?.desktop?.page, qid: j.wikibase_item || null, description: j.description || null };
  });
}

// Scores article sentences for "huh, I didn't know that" value.
const HOOKS = [
  [/\b(first|only|oldest|largest|longest|tallest|biggest|highest|earliest|last surviving)\b/i, 3],
  [/\b(named after|named for|name (comes|derives)|originally (called|known)|formerly|renamed)\b/i, 3],
  [/\b(Gandhi|British|Peshwa|Maratha|Mughal|Aga Khan|Osho|Rajneesh|Ambedkar|Tilak|Nehru|Churchill|war|famine|plague|independence|imprison|interned|died)\b/i, 2],
  [/\b(world|Asia|India's|country's|state's)\b/i, 1.5],
  [/\b(unusual|unique|rare|famous|notable|legend|reportedly|believed|record|despite|although|however)\b/i, 1.5],
  [/\b(species|birds?|migratory|flamingo|wildlife)\b/i, 1.5],
  [/\d/, 0.8],
];
function scoreSentence(s, i) {
  let sc = 0;
  for (const [re, w] of HOOKS) if (re.test(s)) sc += w;
  if (i === 0) sc -= 2.5; // definitional lead
  if (s.length < 60) sc -= 2;
  if (s.length > 280) sc -= 1.5;
  if (/\b(is located|is situated|is a (suburb|locality|neighbourhood)|pin code|postal|\bward\b)/i.test(s)) sc -= 2.5;
  if (/\b(coordinates|citation needed|see also)\b/i.test(s)) sc -= 5;
  return sc;
}
export function wikiHighlights(title, exclude = []) {
  return memo('h:' + title, async () => {
    const j = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`);
    const page = Object.values(j.query.pages)[0];
    const text = (page.extract || '').split(/\n==|\n\n(?=(References|External links|See also|Notes|Further reading)\b)/)[0];
    const body = (page.extract || '').replace(/\n+(References|External links|See also|Notes|Further reading|Gallery)\n[\s\S]*$/i, '');
    const sentences = body
      .replace(/\n+/g, ' ')
      .split(/(?<=[a-z\)\]]{2}[.!?])\s+(?=[A-Z"'])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 40 && !/^=/.test(s));
    const scored = sentences.map((s, i) => ({ s, sc: scoreSentence(s, i) + Math.random() * 0.01, i })).filter((x) => x.sc >= 2.5);
    scored.sort((a, b) => b.sc - a.sc);
    return { sentences: scored.slice(0, 8).map((x) => x.s), length: text.length };
  }).then((r) => {
    const ex = exclude.map((e) => e.toLowerCase().slice(0, 40));
    const words = (s) => new Set(s.toLowerCase().match(/[a-z]{5,}/g) || []);
    const exWords = exclude.map(words);
    return r.sentences
      .filter((s) => !ex.some((e) => s.toLowerCase().includes(e)))
      .filter((s) => {
        // Drop sentences that restate a curated fact.
        const w = words(s);
        return exWords.every((ew) => { let n = 0; for (const x of w) if (ew.has(x)) n++; return n / Math.max(1, w.size) < 0.45; });
      })
      .slice(0, 3);
  });
}

// Selected Wikidata properties turned into readable facts.
const PROPS = {
  P1435: (v) => `Officially protected: ${v}.`,
  P138: (v) => `Named after ${v}.`,
  P84: (v) => `Architect: ${v}.`,
  P149: (v) => `Architectural style: ${v}.`,
  P88: (v) => `Commissioned by ${v}.`,
  P127: (v) => `Owned by ${v}.`,
  P137: (v) => `Operated by ${v}.`,
  P2044: (v) => `Sits about ${v} m above sea level.`,
  P2043: (v) => `Length: about ${v} m.`,
  P2046: (v) => `Area: ${v}.`,
  P1083: (v) => `Capacity: ${v}.`,
  P3872: (v) => `Annual patronage: ${v}.`,
  P1174: (v) => `Visitors per year: ${v}.`,
  P403: (v) => `Flows into the ${v}.`,
  P885: (v) => `Rises at ${v}.`,
  P2227: (v) => `Surface elevation of the source: ${v}.`,
  P793: (v) => `Significant event: ${v}.`,
};
export function wikidataFacts(qid) {
  return memo('w:' + qid, async () => {
    const j = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=claims|descriptions&languages=en&format=json&origin=*`);
    const ent = j.entities[qid];
    const claims = ent.claims || {};
    const wanted = [];
    const refIds = new Set();
    for (const p of Object.keys(PROPS)) {
      const cl = (claims[p] || []).filter((c) => c.rank !== 'deprecated').slice(0, 2);
      for (const c of cl) {
        const dv = c.mainsnak?.datavalue;
        if (!dv) continue;
        if (dv.type === 'wikibase-entityid') { refIds.add(dv.value.id); wanted.push({ p, id: dv.value.id }); }
        else if (dv.type === 'quantity') {
          const amt = Math.round(parseFloat(dv.value.amount));
          const unit = dv.value.unit.endsWith('Q712226') ? ' km²' : dv.value.unit.endsWith('Q35852') ? ' ha' : dv.value.unit.endsWith('Q25343') ? ' m²' : '';
          wanted.push({ p, text: amt.toLocaleString('en-IN') + (p === 'P2044' || p === 'P2043' ? '' : unit) });
        }
      }
    }
    let labels = {};
    if (refIds.size) {
      const l = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${[...refIds].slice(0, 45).join('|')}&props=labels&languages=en&format=json&origin=*`);
      for (const [id, e] of Object.entries(l.entities)) labels[id] = e.labels?.en?.value;
    }
    const facts = [];
    const byProp = {};
    for (const w of wanted) {
      const v = w.text ?? labels[w.id];
      if (!v) continue;
      (byProp[w.p] ||= []).push(v);
    }
    for (const [p, vs] of Object.entries(byProp)) facts.push(PROPS[p](vs.join(' and ')));
    return { facts, description: ent.descriptions?.en?.value || null };
  });
}

export function titleFromQid(qid) {
  return memo('t:' + qid, async () => {
    const j = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json&origin=*`);
    return j.entities[qid]?.sitelinks?.enwiki?.title || null;
  });
}

export function nearbyArticles(lat, lon, exclude) {
  return memo(`g:${lat.toFixed(3)},${lon.toFixed(3)}`, async () => {
    const j = await getJSON(`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${lat}|${lon}&gsradius=1200&gslimit=12&format=json&origin=*`);
    return j.query.geosearch.map((g) => ({ title: g.title, dist: g.dist }));
  }).then((list) => list.filter((g) => !exclude?.includes(g.title)).slice(0, 5));
}
