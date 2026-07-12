// Content script (mundo aislado). Pinta un semáforo junto a cada producto y muestra
// un tooltip con aditivos, riesgo, efectos, Nutri-Score/NOVA y nutrientes clave.
// Incluye filtros de salud y dieta (panel flotante 🍏), alerta de alérgenos propios,
// búsqueda de alternativa más sana y nota media del carro.
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
  const NUTRI_COLORS = { a: '#238b45', b: '#85bb2f', c: '#fecb02', d: '#ee8100', e: '#e63e11' };

  let DB = {};        // "E250" -> {nombre, tipo, riesgo, efectos, fuente}
  let KW = {};        // "goma guar" -> "E412"
  const idByThumb = new Map();
  const idByName = new Map();
  const detailCache = new Map();
  const offCache = new Map();      // ean -> promesa con datos de Open Food Facts
  const altCache = new Map();      // id de categoría -> promesa con productos
  const registry = new Map();      // badge -> { card, info } para aplicar filtros
  let ready = false;
  let marked = 0;

  // ---------- ajustes (persisten en chrome.storage.local) ----------
  const DEFAULT_SETTINGS = {
    health: 'none',                // none | dim | hide → qué hacer con 🔴/🟠
    diet: { gluten: false, lactosa: false, vegano: false, vegetariano: false },
    dietMode: 'dim',               // dim | hide → qué hacer con los que NO cumplen la dieta
    allergens: [],                 // claves de ALLERGENS marcadas por el usuario
  };
  let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  function loadSettings() {
    try {
      return chrome.storage.local.get('mdnaSettings').then((o) => {
        if (o && o.mdnaSettings) settings = Object.assign({}, settings, o.mdnaSettings,
          { diet: Object.assign({}, settings.diet, o.mdnaSettings.diet || {}) });
      }).catch(() => {});
    } catch (e) { return Promise.resolve(); }
  }
  function saveSettings() {
    try { chrome.storage.local.set({ mdnaSettings: settings }); } catch (e) { /* noop */ }
  }

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
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt1 = (n) => (typeof n === 'number' && isFinite(n)) ? String(Math.round(n * 10) / 10).replace('.', ',') : null;

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
    let color, label, order = 0;
    if (adds.length === 0) { color = RISK.ninguno.color; label = 'Sano · sin aditivos'; }
    else {
      order = Math.max.apply(null, adds.map((a) => RISK[a.riesgo].order));
      const key = Object.keys(RISK).find((k) => RISK[k].order === order && k !== 'desconocido')
        || (adds.some((a) => a.riesgo === 'desconocido') ? 'desconocido' : 'ninguno');
      color = RISK[key].color; label = RISK[key].label;
    }
    return { additives: adds, color: color, label: label, order: order };
  }

  // ---------- alérgenos y dieta ----------
  const ALLERGENS = [
    { key: 'gluten',     label: 'Gluten',            re: /gluten|trigo|cebada|centeno|espelta|kamut/ },
    { key: 'leche',      label: 'Leche/lactosa',     re: /leche|lacte|lactosa|caseina|nata|mantequilla/ },
    { key: 'huevo',      label: 'Huevo',             re: /huevo|ovoproducto|albumina/ },
    { key: 'soja',       label: 'Soja',              re: /soja/ },
    { key: 'cascara',    label: 'Frutos de cáscara', re: /frutos? de cascara|almendra|avellana|nuez|nueces|anacardo|pistacho|macadamia/ },
    { key: 'cacahuete',  label: 'Cacahuete',         re: /cacahuete|mani\b/ },
    { key: 'pescado',    label: 'Pescado',           re: /pescado|anchoa|atun|merluza/ },
    { key: 'crustaceos', label: 'Crustáceos',        re: /crustaceo|gamba|langostino|cangrejo/ },
    { key: 'moluscos',   label: 'Moluscos',          re: /molusco|mejillon|calamar|sepia|almeja/ },
    { key: 'sesamo',     label: 'Sésamo',            re: /sesamo|tahin/ },
    { key: 'mostaza',    label: 'Mostaza',           re: /mostaza/ },
    { key: 'apio',       label: 'Apio',              re: /apio/ },
    { key: 'sulfitos',   label: 'Sulfitos',          re: /sulfito|anhidrido sulfuroso/ },
    { key: 'altramuz',   label: 'Altramuz',          re: /altramuz|lupino/ },
  ];
  const allergenLabel = (k) => { const a = ALLERGENS.find((x) => x.key === k); return a ? a.label : k; };

  // Mercadona marca los alérgenos en <strong> dentro de los ingredientes y en el campo allergens
  function detectAllergens(rawIngredients, allergensText) {
    const strongs = [];
    let m;
    const re = /<strong>(.*?)<\/strong>/gi;
    while ((m = re.exec(rawIngredients || '')) !== null) strongs.push(m[1]);
    const source = norm(strongs.join(' ') + ' ' + (allergensText || ''));
    return ALLERGENS.filter((a) => a.re.test(source)).map((a) => a.key);
  }

  function dietStatus(info) {
    const off = info.off || {};
    const has = (k) => info.allergens.indexOf(k) >= 0;
    const sinGluten = /sin gluten/i.test(info.mandatory) || off.glutenFreeLabel ? 'si' : (has('gluten') ? 'no' : '?');
    const sinLactosa = /sin lactosa/i.test(info.mandatory) ? 'si' : (has('leche') ? 'no' : '?');
    return {
      gluten: sinGluten,
      lactosa: sinLactosa,
      vegano: off.vegan || '?',
      vegetariano: off.vegetarian || '?',
    };
  }

  // ---------- almacén ----------
  let sniffedWh = null; // almacén detectado de las peticiones de la propia web (fiable)
  function getWh() {
    if (sniffedWh) return sniffedWh;
    try { const w = JSON.parse(localStorage.getItem('__mo_da') || '{}').warehouse; if (w) return (sniffedWh = w); }
    catch (e) { /* noop */ }
    try {
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

  // ---------- cola de peticiones ----------
  // La API de Mercadona devuelve 403 ante ráfagas; pedimos de pocas en pocas y con
  // reintento en 403. También pasa por aquí Open Food Facts (sin credenciales).
  const fetchQueue = [];
  let inFlight = 0;
  function queuedFetch(url, opts) {
    return new Promise((resolve) => {
      fetchQueue.push({ url: url, opts: opts || { credentials: 'include' }, resolve: resolve, tries: 0 });
      pumpQueue();
    });
  }
  function pumpQueue() {
    if (inFlight >= 4 || fetchQueue.length === 0) return;
    const job = fetchQueue.shift();
    inFlight++;
    fetch(job.url, job.opts)
      .then((r) => {
        if (r.status === 403 && job.tries < 2) {
          job.tries++;
          setTimeout(() => { fetchQueue.push(job); pumpQueue(); }, 2000 * job.tries);
        } else job.resolve(r);
      })
      .catch(() => job.resolve(null))
      .finally(() => { inFlight--; setTimeout(pumpQueue, 120); });
    pumpQueue();
  }

  // ---------- Open Food Facts (Nutri-Score, NOVA, nutrientes, vegano/vegetariano) ----------
  const OFF_FIELDS = 'nutriscore_grade,nova_group,nutriments,ingredients_analysis_tags,labels_tags';
  const OFF_TTL = 30 * 24 * 3600 * 1000; // 30 días de caché persistente
  function tag3(tags, base) {
    if (!tags) return null;
    if (tags.indexOf('en:' + base) >= 0) return 'si';
    if (tags.indexOf('en:non-' + base) >= 0) return 'no';
    if (tags.indexOf('en:maybe-' + base) >= 0) return '?';
    return null;
  }
  function getOff(ean) {
    if (!ean) return Promise.resolve(null);
    if (offCache.has(ean)) return offCache.get(ean);
    const key = 'mdnaOff:' + ean;
    const pr = Promise.resolve()
      .then(() => { try { return chrome.storage.local.get(key); } catch (e) { return {}; } })
      .then((stored) => {
        const hit = stored && stored[key];
        if (hit && Date.now() - hit.ts < OFF_TTL) return hit.v;
        return queuedFetch('https://world.openfoodfacts.org/api/v2/product/' + ean + '?fields=' + OFF_FIELDS, {})
          .then((r) => (r && r.ok ? r.json() : null))
          .then((data) => {
            const p = data && data.status === 1 ? data.product : null;
            const nm = (p && p.nutriments) || {};
            const v = p ? {
              nutri: p.nutriscore_grade && /^[a-e]$/.test(p.nutriscore_grade) ? p.nutriscore_grade : null,
              nova: p.nova_group || null,
              kcal: nm['energy-kcal_100g'], sugars: nm.sugars_100g,
              salt: nm.salt_100g, satfat: nm['saturated-fat_100g'],
              vegan: tag3(p.ingredients_analysis_tags, 'vegan'),
              vegetarian: tag3(p.ingredients_analysis_tags, 'vegetarian'),
              glutenFreeLabel: (p.labels_tags || []).indexOf('en:no-gluten') >= 0,
            } : { missing: true };
            try { chrome.storage.local.set({ [key]: { v: v, ts: Date.now() } }); } catch (e) { /* noop */ }
            return v;
          })
          .catch(() => null);
      });
    offCache.set(ean, pr);
    return pr;
  }

  // ---------- ficha de producto ----------
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
        const det = d.details || {};
        const ing = strip(ni.ingredients);
        const c = classify(ing);
        // categoría: nivel 0 (la API solo pagina por este) y hoja (para elegir la subcategoría)
        let catRoot = null, catLeaf = null, cur = (d.categories || [])[0];
        if (cur) { catRoot = cur.id; while (cur.categories && cur.categories[0]) cur = cur.categories[0]; catLeaf = cur.id; }
        const allergensText = strip(ni.allergens);
        const info = {
          id: String(d.id), name: d.display_name || '', ingredients: ing,
          additives: c.additives, color: c.color, label: c.label, order: c.order,
          allergensText: allergensText,
          allergens: detectAllergens(ni.ingredients, allergensText),
          mandatory: det.mandatory_mentions || '',
          catRoot: catRoot, catLeaf: catLeaf,
          off: null, diet: null,
        };
        return getOff(d.ean).then((off) => {
          info.off = off && !off.missing ? off : null;
          info.diet = dietStatus(info);
          return info;
        });
      })
      .catch(() => { detailCache.delete(id); return null; });
    detailCache.set(id, pr);
    return pr;
  }

  // ---------- alternativa más sana ----------
  function categoryProducts(catRoot, catLeaf) {
    const key = catRoot + ':' + (catLeaf || '');
    if (altCache.has(key)) return altCache.get(key);
    const wh = getWh();
    const pr = queuedFetch('/api/categories/' + catRoot + '/?lang=es' + (wh ? '&wh=' + wh : ''))
      .then((r) => (r && r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return [];
        const subs = d.categories || [];
        const leaf = subs.find((s) => s.id === catLeaf);
        const pool = leaf ? (leaf.products || []) : subs.reduce((acc, s) => acc.concat(s.products || []), []);
        return pool.map((p) => String(p.id));
      })
      .catch(() => []);
    altCache.set(key, pr);
    return pr;
  }
  function findAlternative(info) {
    if (!info.catRoot) return Promise.resolve(null);
    return categoryProducts(info.catRoot, info.catLeaf).then((ids) => {
      const candidates = ids.filter((x) => x !== info.id).slice(0, 12);
      return Promise.all(candidates.map((x) => getDetail(x)));
    }).then((details) => {
      const better = details.filter(Boolean).filter((d) => d.order < info.order);
      better.sort((a, b) => (a.order - b.order) || (a.additives.length - b.additives.length));
      return better[0] || null;
    });
  }
  function altButtonHtml(info) {
    if (info.order < 1) return '';
    return '<div class="mdna-alt"><button type="button" class="mdna-alt-btn">🔄 Buscar alternativa más sana</button><div class="mdna-alt-out"></div></div>';
  }
  function attachAltHandler(rootEl, info) {
    const btn = rootEl.querySelector('.mdna-alt-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const out = rootEl.querySelector('.mdna-alt-out');
      btn.disabled = true;
      out.textContent = 'Analizando la categoría…';
      findAlternative(info).then((alt) => {
        if (!alt) { out.textContent = 'No hay alternativa más limpia en esta categoría.'; return; }
        out.innerHTML = '<span class="mdna-d" style="background:' + alt.color + '"></span> '
          + '<a href="https://tienda.mercadona.es/product/' + esc(alt.id) + '" target="_blank" rel="noopener">'
          + esc(alt.name) + '</a> · ' + esc(alt.label)
          + (alt.additives.length ? ' · ' + alt.additives.length + ' aditivo(s)' : ' · sin aditivos');
      });
    });
  }

  // ---------- contenido del tooltip/panel ----------
  function chipsHtml(info) {
    const off = info.off || {};
    let h = '';
    if (off.nutri) h += '<span class="mdna-chip" style="background:' + NUTRI_COLORS[off.nutri] + '">Nutri-Score ' + off.nutri.toUpperCase() + '</span>';
    if (off.nova) h += '<span class="mdna-chip mdna-chip-nova">NOVA ' + off.nova + '</span>';
    const parts = [];
    if (fmt1(off.kcal)) parts.push(fmt1(off.kcal) + ' kcal');
    if (fmt1(off.sugars) != null) parts.push('azúcar ' + fmt1(off.sugars) + ' g');
    if (fmt1(off.salt) != null) parts.push('sal ' + fmt1(off.salt) + ' g');
    if (fmt1(off.satfat) != null) parts.push('grasa sat. ' + fmt1(off.satfat) + ' g');
    const row = h ? '<div class="mdna-chips-row">' + h + '</div>' : '';
    const nut = parts.length ? '<div class="mdna-nutrients">' + esc(parts.join(' · ')) + ' <span class="mdna-per">/100 g</span></div>' : '';
    return row + nut;
  }
  function dietHtml(info) {
    if (!info.diet) return '';
    const M = { si: '✓', no: '✗', '?': '?' };
    const items = [['Sin gluten', info.diet.gluten], ['Sin lactosa', info.diet.lactosa],
      ['Vegano', info.diet.vegano], ['Vegetariano', info.diet.vegetariano]];
    return '<div class="mdna-diet">' + items.map(([t, v]) =>
      '<span class="mdna-diet-' + (v === 'si' ? 'ok' : v === 'no' ? 'ko' : 'na') + '">' + t + ' ' + M[v] + '</span>'
    ).join(' · ') + '</div>';
  }
  function allergensHtml(info) {
    if (!info.allergensText && !info.allergens.length) return '';
    const mine = settings.allergens.filter((a) => info.allergens.indexOf(a) >= 0);
    let h = '';
    if (mine.length) h += '<div class="mdna-my-allergens">🚨 Tus alérgenos: <b>' + esc(mine.map(allergenLabel).join(', ')) + '</b></div>';
    if (info.allergensText) h += '<div class="mdna-allergens">⚠️ ' + esc(info.allergensText) + '</div>';
    else if (info.allergens.length) h += '<div class="mdna-allergens">⚠️ Alérgenos: ' + esc(info.allergens.map(allergenLabel).join(', ')) + '</div>';
    return h;
  }
  function tipHtml(info) {
    let h = '<div class="mdna-tip-head" style="color:' + info.color + '">● ' + esc(info.label) + '</div>';
    h += chipsHtml(info);
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
    h += allergensHtml(info);
    h += dietHtml(info);
    if (info.ingredients) h += '<div class="mdna-ing"><b>Ingredientes:</b> ' + esc(info.ingredients) + '</div>';
    h += altButtonHtml(info);
    h += '<div class="mdna-foot">Informativo · Mercadona + Open Food Facts + base EFSA/ANSES/IARC/Yuka</div>';
    return h;
  }

  // ---------- tooltip ----------
  let tip, hideTimer = null;
  function tooltip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'mdna-tip';
    tip.style.display = 'none';
    // El tooltip es interactivo (scroll interno y botón de alternativa)
    tip.addEventListener('mouseenter', cancelHide);
    tip.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(tip);
    return tip;
  }
  function cancelHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(() => { hideTimer = null; if (tip) tip.style.display = 'none'; }, 220);
  }
  function showTip(badge) {
    if (!badge._info) return;
    cancelHide();
    const t = tooltip();
    t.innerHTML = tipHtml(badge._info);
    attachAltHandler(t, badge._info);
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

  // ---------- badges y filtros ----------
  function makeBadge() {
    const b = document.createElement('span');
    b.className = 'mdna-badge mdna-loading';
    b.textContent = '';
    b.addEventListener('mouseenter', () => showTip(b));
    b.addEventListener('mouseleave', scheduleHide);
    return b;
  }
  function applyBadge(badge, info, card) {
    badge.classList.remove('mdna-loading');
    badge.style.background = info.color;
    badge._info = info;
    registry.set(badge, { card: card || null, info: info });
    applyFilterTo(badge, registry.get(badge));
  }
  function applyFilterTo(badge, rec) {
    const info = rec.info;
    let dim = false, hide = false;
    if (settings.health !== 'none' && info.order >= 2) {
      if (settings.health === 'hide') hide = true; else dim = true;
    }
    if (info.diet) {
      const fails = ['gluten', 'lactosa', 'vegano', 'vegetariano']
        .some((k) => settings.diet[k] && info.diet[k] === 'no');
      if (fails) { if (settings.dietMode === 'hide') hide = true; else dim = true; }
    }
    const alert = settings.allergens.some((a) => info.allergens.indexOf(a) >= 0);
    badge.classList.toggle('mdna-alert', alert);
    if (rec.card) {
      rec.card.classList.toggle('mdna-dim', dim && !hide);
      rec.card.classList.toggle('mdna-hide', hide);
    }
  }
  function applyAllFilters() {
    registry.forEach((rec, badge) => {
      if (!badge.isConnected) { registry.delete(badge); return; }
      applyFilterTo(badge, rec);
    });
  }

  // Carga perezosa: solo se piden las fichas de las tarjetas visibles (o casi).
  // Evita ráfagas de 100+ peticiones en búsquedas/categorías, que la API corta con 403.
  const lazyObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      lazyObserver.unobserve(en.target);
      const badge = en.target;
      getDetail(badge._mdnaId).then((info) => {
        if (info) { applyBadge(badge, info, badge._cardEl); marked++; logStatus(); }
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
    // Si React borró un badge al re-renderizar, la tarjeta se vuelve a procesar
    document.querySelectorAll('[data-testid="product-cell-name"][data-mdna]').forEach((el) => {
      if (!el.querySelector('.mdna-badge')) el.removeAttribute('data-mdna');
    });
    const names = document.querySelectorAll('[data-testid="product-cell-name"]:not([data-mdna])');
    names.forEach((el) => {
      const id = resolveId(el);
      if (!id) return; // aún no tenemos el id (el hook no lo ha visto); se reintenta al llegar más datos
      el.setAttribute('data-mdna', '1');
      const badge = makeBadge();
      badge._mdnaId = id;
      badge._cardEl = el.closest('[class*="product-cell"]') || el.closest('button') || el.parentElement;
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
    if (!h1) return;
    // data-mdna = "<id>:<estado>". La ficha (sobre todo el modal) se renderiza en fases y
    // React puede borrar nuestro badge/panel al re-renderizar: si faltan, se repinta.
    const attr = h1.getAttribute('data-mdna');
    const badgeAlive = !!h1.querySelector('.mdna-badge');
    if (attr === id + ':pending') return; // ficha ya en camino
    if (attr === id + ':done' && badgeAlive && document.querySelector('.mdna-panel')) return;
    h1.setAttribute('data-mdna', id + ':pending');
    const stale = h1.querySelector('.mdna-badge'); if (stale) stale.remove();
    document.querySelectorAll('.mdna-panel').forEach((p) => p.remove());
    const badge = makeBadge();
    badge.classList.add('mdna-badge-lg');
    h1.insertAdjacentElement('afterbegin', badge);
    h1.insertBefore(document.createTextNode(' '), badge.nextSibling);
    getDetail(id).then((info) => {
      // Si mientras tanto se navegó a otro producto o se desmontó el h1, no pintar aquí
      if (!h1.isConnected || h1.getAttribute('data-mdna') !== id + ':pending') { badge.remove(); return; }
      if (!info) { badge.remove(); h1.removeAttribute('data-mdna'); return; }
      h1.setAttribute('data-mdna', id + ':done');
      applyBadge(badge, info, null);
      // En la ficha hay espacio: panel siempre visible bajo el título, sin depender del hover
      const panel = document.createElement('div');
      panel.className = 'mdna-panel';
      panel.innerHTML = tipHtml(info);
      attachAltHandler(panel, info);
      h1.insertAdjacentElement('afterend', panel);
      marked++; logStatus();
    });
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; if (ready) { scanCards(); scanDetailPage(); } }, 120);
  }

  // ---------- nota media del carro ----------
  let cartSignature = null;
  function updateCartScore(lines) {
    const sig = JSON.stringify(lines);
    if (sig === cartSignature) return;
    cartSignature = sig;
    if (!lines.length) { renderCartScore(null, 0); return; }
    Promise.all(lines.map((l) => getDetail(l.id).then((i) => ({ info: i, qty: l.qty }))))
      .then((rows) => {
        const NOTA = [10, 6.5, 3.5, 1]; // por orden de riesgo (verde→rojo)
        let sum = 0, w = 0;
        rows.forEach((r) => { if (r.info) { sum += NOTA[r.info.order] * r.qty; w += r.qty; } });
        renderCartScore(w ? sum / w : null, w);
      });
  }
  function renderCartScore(score, count) {
    const chip = document.querySelector('.mdna-fab-score');
    const line = document.querySelector('.mdna-cart-val');
    const txt = score == null ? '—' : fmt1(score);
    const color = score == null ? '#8a8a8a' : score >= 7.5 ? RISK.ninguno.color : score >= 5 ? RISK.limitado.color : score >= 2.5 ? RISK.moderado.color : RISK.elevado.color;
    if (chip) {
      chip.textContent = txt;
      chip.style.background = color;
      chip.style.display = score == null ? 'none' : '';
    }
    if (line) line.innerHTML = score == null
      ? 'Sin datos (inicia sesión y abre el carro)'
      : '<b style="color:' + color + '">' + txt + '</b> / 10 · ' + count + ' producto(s)';
  }

  // ---------- panel flotante (filtros y ajustes) ----------
  function buildUi() {
    if (document.querySelector('.mdna-fab')) return;
    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'mdna-fab';
    fab.title = 'Semáforo Sano · filtros';
    fab.innerHTML = '🍏<span class="mdna-fab-score" style="display:none"></span>';
    const sheet = document.createElement('div');
    sheet.className = 'mdna-sheet';
    sheet.style.display = 'none';
    sheet.innerHTML =
      '<div class="mdna-sheet-head">🍏 Semáforo Sano</div>'
      + '<div class="mdna-sec"><div class="mdna-sec-t">Productos 🔴/🟠</div>'
      + '<div class="mdna-seg" data-set="health">'
      + '<button type="button" data-v="none">Mostrar</button>'
      + '<button type="button" data-v="dim">Atenuar</button>'
      + '<button type="button" data-v="hide">Ocultar</button></div></div>'
      + '<div class="mdna-sec"><div class="mdna-sec-t">Dieta <span class="mdna-hint">(sin datos = no se filtra)</span></div>'
      + '<div class="mdna-checks">'
      + ['gluten|Sin gluten', 'lactosa|Sin lactosa', 'vegano|Vegano', 'vegetariano|Vegetariano']
        .map((x) => { const [k, t] = x.split('|'); return '<label><input type="checkbox" data-diet="' + k + '"> ' + t + '</label>'; }).join('')
      + '</div>'
      + '<div class="mdna-seg" data-set="dietMode">'
      + '<button type="button" data-v="dim">Atenuar</button>'
      + '<button type="button" data-v="hide">Ocultar</button></div></div>'
      + '<div class="mdna-sec"><div class="mdna-sec-t">Mis alérgenos <span class="mdna-hint">(aviso 🚨 en el punto)</span></div>'
      + '<div class="mdna-chips">'
      + ALLERGENS.map((a) => '<button type="button" class="mdna-al" data-al="' + a.key + '">' + esc(a.label) + '</button>').join('')
      + '</div></div>'
      + '<div class="mdna-sec"><div class="mdna-sec-t">Nota del carro</div><div class="mdna-cart-val">Sin datos (inicia sesión y abre el carro)</div></div>';
    document.body.appendChild(fab);
    document.body.appendChild(sheet);

    fab.addEventListener('click', () => {
      sheet.style.display = sheet.style.display === 'none' ? '' : 'none';
    });
    document.addEventListener('click', (ev) => {
      if (sheet.style.display !== 'none' && !sheet.contains(ev.target) && !fab.contains(ev.target)) sheet.style.display = 'none';
    });
    sheet.addEventListener('click', (ev) => {
      const seg = ev.target.closest('.mdna-seg button');
      if (seg) {
        settings[seg.parentElement.getAttribute('data-set')] = seg.getAttribute('data-v');
        saveSettings(); syncUi(); applyAllFilters();
        return;
      }
      const al = ev.target.closest('.mdna-al');
      if (al) {
        const k = al.getAttribute('data-al');
        const i = settings.allergens.indexOf(k);
        if (i >= 0) settings.allergens.splice(i, 1); else settings.allergens.push(k);
        saveSettings(); syncUi(); applyAllFilters();
      }
    });
    sheet.addEventListener('change', (ev) => {
      const cb = ev.target.closest('input[data-diet]');
      if (!cb) return;
      settings.diet[cb.getAttribute('data-diet')] = cb.checked;
      saveSettings(); applyAllFilters();
    });
    syncUi();
  }
  function syncUi() {
    document.querySelectorAll('.mdna-seg').forEach((seg) => {
      const key = seg.getAttribute('data-set');
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', settings[key] === b.getAttribute('data-v')));
    });
    document.querySelectorAll('input[data-diet]').forEach((cb) => { cb.checked = !!settings.diet[cb.getAttribute('data-diet')]; });
    document.querySelectorAll('.mdna-al').forEach((b) => b.classList.toggle('on', settings.allergens.indexOf(b.getAttribute('data-al')) >= 0));
  }

  // ---------- mensajes del hook (mundo principal) ----------
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__mdnaSem) return;
    if (ev.data.wh) sniffedWh = ev.data.wh;
    if (Array.isArray(ev.data.cart)) updateCartScore(ev.data.cart);
    const ps = ev.data.products || [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.thumb) { const h = thumbHash(p.thumb); if (h) idByThumb.set(h, p.id); }
      if (p.name) idByName.set(norm(p.name), p.id);
    }
    scheduleScan();
  });

  // Saluda al hook (mundo principal) para que reenvíe el wh, los productos y el carro que
  // capturó antes de que este script estuviera escuchando (p. ej. carga directa de una ficha).
  window.postMessage({ __mdnaSemHello: 1 }, '*');

  // ---------- init ----------
  Promise.all([
    fetch(chrome.runtime.getURL('data/aditivos.json')).then((r) => r.json()),
    loadSettings(),
  ])
    .then(([cfg]) => {
      for (const k in cfg.aditivos) DB[k.toUpperCase()] = cfg.aditivos[k];
      KW = cfg.palabras_clave || {};
      ready = true;
      buildUi();
      console.log('%c🚦 Semáforo Sano activo', 'font-weight:bold;color:#2f9e63',
        '· ' + Object.keys(DB).length + ' aditivos cargados · almacén ' + (getWh() || 'detectando…') + ' · pulsa el botón 🍏 para filtros');
      const mo = new MutationObserver(scheduleScan);
      mo.observe(document.documentElement, { childList: true, subtree: true });
      scheduleScan();
    })
    .catch(() => {});
})();
