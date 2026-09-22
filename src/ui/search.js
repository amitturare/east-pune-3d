const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function score(q, name) {
  const n = norm(name);
  if (n === q) return 100;
  if (n.startsWith(q)) return 80 - n.length * 0.1;
  const words = n.split(' ');
  if (words.some((w) => w.startsWith(q))) return 60 - n.length * 0.1;
  if (n.includes(q)) return 45 - n.length * 0.1;
  const compact = n.replace(/ /g, '');
  if (compact.includes(q.replace(/ /g, ''))) return 40;
  // Subsequence match for typos like "phnx".
  let i = 0;
  for (const ch of compact) if (ch === q[i]) i++;
  return i === q.replace(/ /g, '').length ? 18 - n.length * 0.05 : 0;
}

export class Search {
  constructor(input, list, onPick) {
    this.input = input;
    this.list = list;
    this.onPick = onPick;
    this.entries = [];
    this.active = 0;
    this.results = [];
    input.addEventListener('input', () => this.run());
    input.addEventListener('focus', () => this.run());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { this.active = Math.min(this.results.length - 1, this.active + 1); this.render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.active = Math.max(0, this.active - 1); this.render(); e.preventDefault(); }
      else if (e.key === 'Enter' && this.results[this.active]) this.pick(this.results[this.active]);
      else if (e.key === 'Escape') { input.blur(); this.close(); }
    });
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#search')) this.close(); });
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); input.select(); }
    });
  }

  setEntries(entries) {
    // Deduplicate by normalised name + kind, keeping the higher-weight entry.
    const map = new Map();
    for (const e of entries) {
      const k = norm(e.name) + '|' + e.kind;
      if (!map.has(k) || (map.get(k).weight || 0) < (e.weight || 0)) map.set(k, e);
    }
    this.entries = [...map.values()];
  }

  run() {
    const q = norm(this.input.value);
    if (!q) {
      this.results = this.entries.filter((e) => e.featured).slice(0, 9);
    } else {
      this.results = this.entries
        .map((e) => ({ e, s: score(q, e.name) + (e.weight || 0) }))
        .filter((r) => r.s > 10)
        .sort((a, b) => b.s - a.s)
        .slice(0, 9)
        .map((r) => r.e);
    }
    this.active = 0;
    this.render();
  }

  render() {
    const q = norm(this.input.value);
    if (!this.results.length) {
      this.list.innerHTML = q ? '<div class="result"><span class="r-name muted">No matches in East Pune</span></div>' : '';
      this.list.classList.toggle('open', !!q);
      return;
    }
    this.list.innerHTML = this.results
      .map((r, i) => {
        let name = r.name.replace(/[&<>]/g, '');
        if (q) {
          const idx = norm(name).indexOf(q);
          if (idx >= 0 && norm(name).length === name.length) name = name.slice(0, idx) + '<mark>' + name.slice(idx, idx + q.length) + '</mark>' + name.slice(idx + q.length);
        }
        return `<div class="result${i === this.active ? ' active' : ''}" data-i="${i}"><span class="dot" style="background:${r.color}"></span><span class="r-name">${name}</span><span class="r-kind">${r.kindLabel || r.kind}</span></div>`;
      })
      .join('');
    this.list.classList.add('open');
    this.list.querySelectorAll('.result[data-i]').forEach((el) => el.addEventListener('click', () => this.pick(this.results[+el.dataset.i])));
  }

  pick(r) {
    this.input.value = r.name;
    this.close();
    this.input.blur();
    this.onPick(r);
  }

  close() {
    this.list.classList.remove('open');
  }
}
