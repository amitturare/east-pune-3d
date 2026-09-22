import { CATEGORY } from '../world/palette.js';
import { wikiSummary, wikiHighlights, wikidataFacts, nearbyArticles, titleFromQid } from '../facts.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const SRC = [
  ['real', 'OSM height tag'],
  ['levels', 'From OSM floor count'],
  ['est', 'Estimated'],
];

export class InfoPanel {
  constructor(root, body, closeBtn) {
    this.root = root;
    this.body = body;
    this.token = 0;
    closeBtn.addEventListener('click', () => this.close());
    this.onClose = () => {};
  }

  close() {
    this.root.classList.add('hidden');
    this.token++;
    this.onClose();
  }

  open(html) {
    this.body.innerHTML = html;
    this.root.classList.remove('hidden');
    this.root.scrollTop = 0;
  }

  // lm: curated or discovered landmark; ctx: map-derived facts
  async showLandmark(lm, ctx) {
    const token = ++this.token;
    const cat = CATEGORY[lm.category] || CATEGORY.civic;
    const curated = lm.facts || [];
    this.open(`
      <div class="info-hero" id="info-hero" style="display:none"></div>
      <div class="info-head">
        <div class="info-cat"><i style="background:${cat.color}"></i>${esc(cat.label)}</div>
        <div class="info-title">${esc(lm.name)}</div>
        <div class="info-tag" id="info-tag">${esc(lm.tagline || '')}</div>
      </div>
      ${curated.length ? `<div class="info-sec"><h4>Did you know</h4><ul class="facts">${curated.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
      <div class="info-sec" id="info-live"><h4>From Wikipedia &amp; Wikidata <span class="live">LIVE</span></h4><ul class="facts live"><li class="skel"></li><li class="skel" style="width:80%"></li><li class="skel" style="width:60%"></li></ul></div>
      ${ctx.length ? `<div class="info-sec"><h4>From the map data</h4><ul class="facts live">${ctx.map((f) => `<li>${f}</li>`).join('')}</ul></div>` : ''}
      <div class="info-sec" id="info-near" style="display:none"></div>
      <div class="info-links" id="info-links">
        ${lm.osm ? `<a href="https://www.openstreetmap.org/${lm.osm}" target="_blank" rel="noopener">OpenStreetMap ↗</a>` : ''}
      </div>`);

    let title = lm.wikipedia;
    const qid = lm.wikidata;
    try {
      if (!title && qid) title = await titleFromQid(qid);
    } catch {}
    const live = [];
    const jobs = [];
    if (title) {
      jobs.push(
        wikiSummary(title).then((s) => {
          if (token !== this.token) return;
          const hero = document.getElementById('info-hero');
          if (s.thumb && hero) { hero.style.backgroundImage = `url("${s.image || s.thumb}")`; hero.style.display = ''; }
          const tag = document.getElementById('info-tag');
          if (tag && !lm.tagline && s.description) tag.textContent = s.description[0].toUpperCase() + s.description.slice(1);
          const links = document.getElementById('info-links');
          if (links && s.url) links.insertAdjacentHTML('afterbegin', `<a href="${s.url}" target="_blank" rel="noopener">Wikipedia ↗</a>`);
          if (!curated.length && s.extract) live.unshift({ t: s.extract.split(/(?<=\.)\s/).slice(0, 2).join(' '), w: 0 });
        }),
        wikiHighlights(title, curated).then((hs) => hs.forEach((h) => live.push({ t: h, w: 1 }))),
      );
    }
    const q = qid || null;
    if (q) jobs.push(wikidataFacts(q).then((w) => w.facts.slice(0, 3).forEach((f) => live.push({ t: f, w: 2 }))));
    if (ctx.latlon) {
      jobs.push(
        nearbyArticles(ctx.latlon[0], ctx.latlon[1], [title]).then((list) => {
          if (token !== this.token || !list.length) return;
          const el = document.getElementById('info-near');
          if (!el) return;
          el.style.display = '';
          el.innerHTML = `<h4>Nearby on Wikipedia <span class="live">LIVE</span></h4><div class="muted">${list.map((g) => `<a style="color:inherit" href="https://en.wikipedia.org/wiki/${encodeURIComponent(g.title.replace(/ /g, '_'))}" target="_blank" rel="noopener">${esc(g.title)}</a> <span style="opacity:.6">${(g.dist / 1000).toFixed(1)} km</span>`).join(' · ')}</div>`;
        }),
      );
    }
    await Promise.allSettled(jobs);
    if (token !== this.token) return;
    const el = document.getElementById('info-live');
    if (!el) return;
    const items = live.sort((a, b) => a.w - b.w).slice(0, 5);
    if (!items.length) {
      el.innerHTML = `<h4>From Wikipedia &amp; Wikidata</h4><div class="muted">${title || qid ? 'Could not reach Wikipedia right now.' : 'No Wikipedia article is linked to this place in OpenStreetMap.'}</div>`;
      return;
    }
    el.innerHTML = `<h4>From Wikipedia &amp; Wikidata <span class="live">LIVE</span></h4><ul class="facts live">${items.map((f) => `<li>${esc(f.t)}</li>`).join('')}</ul>`;
  }

  showBuilding(b, ctx) {
    ++this.token;
    const [cls, label] = SRC[b.src];
    const type = b.type === 'yes' ? 'Building' : b.type.replace(/_/g, ' ');
    this.open(`
      <div class="info-head">
        <div class="info-cat"><i style="background:#c7ced8"></i>Building</div>
        <div class="info-title">${esc(b.name || type[0].toUpperCase() + type.slice(1))}</div>
        <div class="info-tag">${esc(b.name ? type : 'Unnamed footprint from OpenStreetMap')}</div>
      </div>
      <div class="info-sec">
        <dl class="kv">
          <dt>Height</dt><dd>${b.src === 2 ? '~' : ''}${b.h.toFixed(1)} m <span class="badge ${cls}">${label}</span></dd>
          ${b.levels ? `<dt>Floors (OSM)</dt><dd>${b.levels}</dd>` : ''}
          ${b.minH ? `<dt>Starts at</dt><dd>${b.minH.toFixed(1)} m</dd>` : ''}
          <dt>Footprint</dt><dd>${Math.round(b.area).toLocaleString('en-IN')} m²</dd>
          <dt>Ground level</dt><dd>${Math.round(ctx.asl)} m above sea level</dd>
          <dt>OSM type</dt><dd>${esc(b.type)}</dd>
        </dl>
        <p class="muted" style="margin:10px 0 0;line-height:1.5">${b.src === 2
          ? 'OpenStreetMap has no height or floor count for this building, so it is drawn with a coarse estimate based on its type and footprint size. You can add the real value on OpenStreetMap.'
          : b.src === 1 ? 'Height derived from the mapped number of floors (3.2 m per floor).' : 'Height comes directly from the OpenStreetMap height tag.'}</p>
      </div>
      <div class="info-links"><a href="https://www.openstreetmap.org/${b.id[0] === 'r' ? 'relation' : 'way'}/${b.id.slice(1)}" target="_blank" rel="noopener">View on OpenStreetMap ↗</a></div>`);
  }
}
