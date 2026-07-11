// Content script (mundo aislado). Pinta un semáforo junto a cada producto y muestra
// un tooltip con aditivos, riesgo y efectos al pasar el ratón.
(function () {
  'use strict';

  const RISK = {
    elevado:    { color: '#cf4436', order: 3, label: 'Evitar' },
    moderado:   { color: '#dd6f2c', order: 2, label: 'Mejor evitar' },
    limitado:   { color: '#c99512', order: 1, label: 'Aceptable' },
    ninguno:    { color: '#2f9e63', order: 0, label: 'Sano' },
    desconocido:{ color: '#8a8a8a', order: 1, label: 'Revisar' },
  };
  const E_RE = /\bE[\s-]?(\d{3,4}[a-z]?)\b/gi;

  let DB = {};        // "E250" -> {nombre, tipo, riesgo, efectos, fuente}
  let KW = {};        // "goma guar" -> "E412"
  const idByThumb = new Map();
  const idByName = new Map();
  const detailCache = new Map();
  let ready = false;
  let marked = 0;

  let statusTimer = null;
  function logStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      console.log('%c🚦 Semáforo Sano', 'font-weight:bold;color:#2f9e63',
        '· ' + marked + ' productos marcados · ' + detailCache.size + ' fichas analizadas · almacén ' + (getWh() || '?'));
    }, 400);
  }

  // ---------- utilidades ----------
  const norm = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
  const strip = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/^\s*ingredientes:\s*/i, '').trim();
  const thumbHash = (url) => { const m = /images\/([a-f0-9]+)\./i.exec(url || ''); return m ? m[1] : null; };

  function additivesFromText(ing) {
    const found = new Set();
    let m;
    const re = new RegExp(E_RE);
    while ((m = re.exec(ing)) !== null) found.add('E' + m[1].toUpperCase());
    const low = (ing || '').toLowerCase();
    for (const k in KW) {
      if (k.charAt(0) === '_') continue;
      if (low.indexOf(k) >= 0) found.add(String(KW[k]).toUpperCase());
    }
    return Array.from(found);
  }

  function classify(ing) {
    const adds = additivesFromText(ing).map((e) => {
      const info = DB[e] || { nombre: 'Aditivo no catalogado', riesgo: 'desconocido', efectos: 'Sin ficha en la base local.', fuente: '' };
      return { e: e, nombre: info.nombre, riesgo: info.riesgo, efectos: info.efectos || '', fuente: info.fuente || '' };
    });
    adds.sort((a, b) => RISK[b.riesgo].order - RISK[a.riesgo].order);
    let color, label;
    if (adds.length === 0) { color = RISK.ninguno.color; label = 'Sano · sin aditivos'; }
    else {
      const worst = Math.max.apply(null, adds.map((a) => RISK[a.riesgo].order));
      const key = Object.keys(RISK).find((k) => RISK[k].order === worst && k !== 'desconocido')
        || (adds.some((a) => a.riesgo === 'desconocido') ? 'desconocido' : 'ninguno');
      color = RISK[key].color; label = RISK[key].label;
    }
    return { additives: adds, color: color, label: label };
  }

  let sniffedWh = null; // almacén detectado de las peticiones de la propia web (fiable)
  function getWh() {
    if (sniffedWh) return sniffedWh;
    try { const w = JSON.parse(localStorage.getItem('__mo_da') || '{}').warehouse; if (w) return w; }
    catch (e) { /* noop */ }
    return null; // aún no conocido: no pedimos fichas hasta saberlo (evita 404 con almacén erróneo)
  }

  function getDetail(id) {
    if (detailCache.has(id)) return detailCache.get(id);
    const pr = fetch('/api/products/' + id + '/?lang=es&wh=' + getWh(), { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return null;
        const ni = d.nutrition_information || {};
        const ing = strip(ni.ingredients);
        const c = classify(ing);
        return { ingredients: ing, additives: c.additives, color: c.color, label: c.label };
      })
      .catch(() => null);
    detailCache.set(id, pr);
    return pr;
  }

  // ---------- tooltip ----------
  let tip;
  function tooltip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'mdna-tip';
    tip.style.display = 'none';
    document.body.appendChild(tip);
    return tip;
  }
  function tipHtml(info) {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let h = '<div class="mdna-tip-head" style="color:' + info.color + '">● ' + esc(info.label) + '</div>';
    if (info.additives && info.additives.length) {
      h += '<ul class="mdna-tip-list">';
      info.additives.forEach((a) => {
        const c = RISK[a.riesgo] ? RISK[a.riesgo].color : '#8a8a8a';
        h += '<li><span class="mdna-d" style="background:' + c + '"></span>'
          + '<span><b>' + esc(a.e) + ' ' + esc(a.nombre) + '</b> <i>(' + esc(a.riesgo) + ')</i>'
          + (a.efectos ? '<br><span class="mdna-eff">' + esc(a.efectos) + '</span>' : '')
          + (a.fuente ? ' <span class="mdna-src">[' + esc(a.fuente) + ']</span>' : '')
          + '</span></li>';
      });
      h += '</ul>';
    } else {
      h += '<div class="mdna-none">✅ Sin aditivos</div>';
    }
    if (info.ingredients) h += '<div class="mdna-ing"><b>Ingredientes:</b> ' + esc(info.ingredients) + '</div>';
    h += '<div class="mdna-foot">Informativo · aditivos vía Mercadona + base EFSA/ANSES/IARC/Yuka</div>';
    return h;
  }
  function showTip(badge) {
    if (!badge._info) return;
    const t = tooltip();
    t.innerHTML = tipHtml(badge._info);
    t.style.display = 'block';
    const r = badge.getBoundingClientRect();
    const tw = Math.min(340, window.innerWidth - 20);
    t.style.width = tw + 'px';
    let left = r.left + window.scrollX;
    if (left + tw > window.scrollX + window.innerWidth - 10) left = window.scrollX + window.innerWidth - tw - 10;
    let top = r.bottom + window.scrollY + 6;
    t.style.left = Math.max(8, left) + 'px';
    t.style.top = top + 'px';
  }
  function hideTip() { if (tip) tip.style.display = 'none'; }

  // ---------- badges ----------
  function makeBadge() {
    const b = document.createElement('span');
    b.className = 'mdna-badge mdna-loading';
    b.textContent = '';
    b.addEventListener('mouseenter', () => showTip(b));
    b.addEventListener('mouseleave', hideTip);
    return b;
  }
  function applyBadge(badge, info) {
    badge.classList.remove('mdna-loading');
    badge.style.background = info.color;
    badge._info = info;
  }

  function resolveId(nameEl) {
    const card = nameEl.closest('button') || nameEl.closest('[class*="product-cell"]') || nameEl.parentElement;
    const img = card ? card.querySelector('img') : null;
    if (img) { const h = thumbHash(img.currentSrc || img.src); if (h && idByThumb.has(h)) return idByThumb.get(h); }
    return idByName.get(norm(nameEl.textContent)) || null;
  }

  function scanCards() {
    const names = document.querySelectorAll('[data-testid="product-cell-name"]:not([data-mdna])');
    names.forEach((el) => {
      const id = resolveId(el);
      if (!id) return; // aún no tenemos el id (el hook no lo ha visto); se reintenta al llegar más datos
      el.setAttribute('data-mdna', '1');
      const badge = makeBadge();
      el.insertAdjacentElement('afterbegin', badge);
      el.insertBefore(document.createTextNode(' '), badge.nextSibling);
      getDetail(id).then((info) => {
        if (info) { applyBadge(badge, info); marked++; logStatus(); }
        else badge.remove();
      });
    });
  }

  function scanDetailPage() {
    const m = /\/product\/([\w.]+)/.exec(location.pathname);
    if (!m) return;
    const id = m[1];
    const h1 = document.querySelector('h1');
    if (!h1 || h1.querySelector('.mdna-badge') || h1.hasAttribute('data-mdna')) return;
    h1.setAttribute('data-mdna', '1');
    const badge = makeBadge();
    badge.classList.add('mdna-badge-lg');
    h1.insertAdjacentElement('afterbegin', badge);
    h1.insertBefore(document.createTextNode(' '), badge.nextSibling);
    getDetail(id).then((info) => { if (info) applyBadge(badge, info); else badge.remove(); });
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; if (ready && getWh()) { scanCards(); scanDetailPage(); } }, 120);
  }

  // ---------- mensajes del hook (mundo principal) ----------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__mdnaSem) return;
    if (ev.data.wh) sniffedWh = ev.data.wh;
    const ps = ev.data.products || [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.thumb) { const h = thumbHash(p.thumb); if (h) idByThumb.set(h, p.id); }
      if (p.name) idByName.set(norm(p.name), p.id);
    }
    scheduleScan();
  });

  // ---------- init ----------
  fetch(chrome.runtime.getURL('data/aditivos.json'))
    .then((r) => r.json())
    .then((cfg) => {
      for (const k in cfg.aditivos) DB[k.toUpperCase()] = cfg.aditivos[k];
      KW = cfg.palabras_clave || {};
      ready = true;
      console.log('%c🚦 Semáforo Sano activo', 'font-weight:bold;color:#2f9e63',
        '· ' + Object.keys(DB).length + ' aditivos cargados · almacén ' + (getWh() || 'detectando…') + ' · navega por una categoría y pasa el ratón por los puntos');
      const mo = new MutationObserver(scheduleScan);
      mo.observe(document.documentElement, { childList: true, subtree: true });
      scheduleScan();
    })
    .catch(() => {});
})();
