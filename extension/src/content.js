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
    try { const w = JSON.parse(localStorage.getItem('__mo_da') || '{}').warehouse; if (w) return (sniffedWh = w); }
    catch (e) { /* noop */ }
    try {
      // Fallback: buscar el wh en las peticiones que la página ya hizo
      // (API con ?wh=, índice de Algolia o centerCode de featureflags)
      const res = performance.getEntriesByType('resource');
      for (let i = res.length - 1; i >= 0; i--) {
        const m = /[?&]wh=([a-z0-9]+)/i.exec(res[i].name)
          || /\/indexes\/products_prod_([a-z0-9]+)_/i.exec(res[i].name)
          || /[?&]properties(?:%5B|\[)centerCode(?:%5D|\])=([a-z0-9]+)/i.exec(res[i].name);
        if (m) return (sniffedWh = m[1]);
      }
    } catch (e) { /* noop */ }
    return null; // sin wh la API suele responder igualmente; getDetail lo maneja
  }

  // Cola con concurrencia limitada: la API de Mercadona devuelve 403 ante ráfagas
  // (una búsqueda puede pintar 120 tarjetas a la vez). En 403 se reintenta con calma.
  const fetchQueue = [];
  let inFlight = 0;
  function queuedFetch(url, tries) {
    return new Promise((resolve) => {
      fetchQueue.push({ url: url, resolve: resolve, tries: tries || 0 });
      pumpQueue();
    });
  }
  function pumpQueue() {
    if (inFlight >= 4 || fetchQueue.length === 0) return;
    const job = fetchQueue.shift();
    inFlight++;
    fetch(job.url, { credentials: 'include' })
      .then((r) => {
        if (r.status === 403 && job.tries < 2) {
          setTimeout(() => {
            fetchQueue.push({ url: job.url, resolve: job.resolve, tries: job.tries + 1 });
            pumpQueue();
          }, 2000 * (job.tries + 1));
        } else job.resolve(r);
      })
      .catch(() => job.resolve(null))
      .finally(() => { inFlight--; setTimeout(pumpQueue, 120); });
    pumpQueue();
  }

  function getDetail(id) {
    if (detailCache.has(id)) return detailCache.get(id);
    const wh = getWh();
    // Con wh si se conoce; si falla (o no hay wh), la API responde también sin él
    const pr = queuedFetch('/api/products/' + id + '/?lang=es' + (wh ? '&wh=' + wh : ''))
      .then((r) => {
        if (r && r.ok) return r.json();
        // 404 = producto no disponible en ese almacén: probar sin wh (403 no; es rate limit)
        if (!r || r.status !== 404 || !wh) return null;
        return queuedFetch('/api/products/' + id + '/?lang=es')
          .then((r2) => (r2 && r2.ok ? r2.json() : null));
      })
      .then((d) => {
        if (!d) { detailCache.delete(id); return null; } // no cachear fallos: permite reintentar
        const ni = d.nutrition_information || {};
        const ing = strip(ni.ingredients);
        const c = classify(ing);
        return { ingredients: ing, additives: c.additives, color: c.color, label: c.label };
      })
      .catch(() => { detailCache.delete(id); return null; });
    detailCache.set(id, pr);
    return pr;
  }

  // ---------- tooltip ----------
  let tip, hideTimer = null;
  function tooltip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'mdna-tip';
    tip.style.display = 'none';
    // El tooltip es interactivo (se puede hacer scroll dentro si no cabe entero)
    tip.addEventListener('mouseenter', cancelHide);
    tip.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(tip);
    return tip;
  }
  function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(() => { hideTimer = null; if (tip) tip.style.display = 'none'; }, 160);
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
    cancelHide();
    const t = tooltip();
    t.innerHTML = tipHtml(badge._info);
    const MARGIN = 10, GAP = 6;
    const tw = Math.min(340, window.innerWidth - 2 * MARGIN);
    t.style.width = tw + 'px';
    t.style.maxHeight = '';
    t.style.visibility = 'hidden';
    t.style.display = 'block';
    // Posición fija respecto al viewport: debajo del badge si cabe, si no encima,
    // y si no cabe entero en ninguno de los dos lados, se limita la altura (scroll interno).
    const r = badge.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    let top;
    if (t.offsetHeight <= below) {
      top = r.bottom + GAP;
    } else if (t.offsetHeight <= above) {
      top = r.top - GAP - t.offsetHeight;
    } else {
      t.style.maxHeight = Math.max(120, Math.max(below, above)) + 'px';
      top = below >= above ? r.bottom + GAP : r.top - GAP - t.offsetHeight;
    }
    const left = Math.min(r.left, window.innerWidth - MARGIN - tw);
    t.style.left = Math.max(MARGIN, left) + 'px';
    t.style.top = Math.max(MARGIN, top) + 'px';
    t.style.visibility = '';
  }

  // ---------- badges ----------
  function makeBadge() {
    const b = document.createElement('span');
    b.className = 'mdna-badge mdna-loading';
    b.textContent = '';
    b.addEventListener('mouseenter', () => showTip(b));
    b.addEventListener('mouseleave', scheduleHide);
    return b;
  }
  function applyBadge(badge, info) {
    badge.classList.remove('mdna-loading');
    badge.style.background = info.color;
    badge._info = info;
  }

  // Carga perezosa: solo se piden las fichas de las tarjetas visibles (o casi).
  // Evita ráfagas de 100+ peticiones en búsquedas/categorías, que la API corta con 403.
  const lazyObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      lazyObserver.unobserve(en.target);
      const badge = en.target;
      getDetail(badge._mdnaId).then((info) => {
        if (info) { applyBadge(badge, info); marked++; logStatus(); }
        else badge.remove();
      });
    });
  }, { rootMargin: '300px' });

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
      badge._mdnaId = id;
      el.insertAdjacentElement('afterbegin', badge);
      el.insertBefore(document.createTextNode(' '), badge.nextSibling);
      lazyObserver.observe(badge);
    });
  }

  function scanDetailPage() {
    const m = /\/product\/([\w.]+)/.exec(location.pathname);
    if (!m) return;
    const id = m[1];
    const h1 = document.querySelector('h1');
    // data-mdna guarda el id: si la SPA reutiliza el h1 para otro producto, se repinta
    if (!h1 || h1.getAttribute('data-mdna') === id) return;
    h1.setAttribute('data-mdna', id);
    const stale = h1.querySelector('.mdna-badge'); if (stale) stale.remove();
    document.querySelectorAll('.mdna-panel').forEach((p) => p.remove());
    const badge = makeBadge();
    badge.classList.add('mdna-badge-lg');
    h1.insertAdjacentElement('afterbegin', badge);
    h1.insertBefore(document.createTextNode(' '), badge.nextSibling);
    getDetail(id).then((info) => {
      if (!info) { badge.remove(); return; }
      applyBadge(badge, info);
      // En la ficha hay espacio: panel siempre visible bajo el título, sin depender del hover
      if (h1.getAttribute('data-mdna') !== id || document.querySelector('.mdna-panel')) return;
      const panel = document.createElement('div');
      panel.className = 'mdna-panel';
      panel.innerHTML = tipHtml(info);
      h1.insertAdjacentElement('afterend', panel);
      marked++; logStatus();
    });
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; if (ready) { scanCards(); scanDetailPage(); } }, 120);
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

  // Saluda al hook (mundo principal) para que reenvíe el wh y los productos que
  // capturó antes de que este script estuviera escuchando (p. ej. carga directa de una ficha).
  window.postMessage({ __mdnaSemHello: 1 }, '*');

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
