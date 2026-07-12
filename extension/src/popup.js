// Popup del icono de la extensión: filtros y ajustes. Lee/escribe chrome.storage.local;
// el content script escucha los cambios y los aplica en vivo en tienda.mercadona.es.
(function () {
  'use strict';

  const ALLERGENS = [
    ['gluten', 'Gluten'], ['leche', 'Leche/lactosa'], ['huevo', 'Huevo'], ['soja', 'Soja'],
    ['cascara', 'Frutos de cáscara'], ['cacahuete', 'Cacahuete'], ['pescado', 'Pescado'],
    ['crustaceos', 'Crustáceos'], ['moluscos', 'Moluscos'], ['sesamo', 'Sésamo'],
    ['mostaza', 'Mostaza'], ['apio', 'Apio'], ['sulfitos', 'Sulfitos'], ['altramuz', 'Altramuz'],
  ];
  const RISK_COLORS = ['#2f9e63', '#c99512', '#dd6f2c', '#cf4436'];
  const DEFAULT_SETTINGS = {
    health: 'none',
    diet: { gluten: false, lactosa: false, vegano: false, vegetariano: false },
    dietMode: 'dim',
    allergens: [],
  };
  let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

  const fmt1 = (n) => String(Math.round(n * 10) / 10).replace('.', ',');

  function save() { chrome.storage.local.set({ mdnaSettings: settings }); }

  function sync() {
    document.querySelectorAll('.seg').forEach((seg) => {
      const key = seg.getAttribute('data-set');
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', settings[key] === b.getAttribute('data-v')));
    });
    document.querySelectorAll('input[data-diet]').forEach((cb) => { cb.checked = !!settings.diet[cb.getAttribute('data-diet')]; });
    document.querySelectorAll('.al').forEach((b) => b.classList.toggle('on', settings.allergens.indexOf(b.getAttribute('data-al')) >= 0));
  }

  function renderCart(cart) {
    const el = document.getElementById('cart');
    if (!cart || cart.score == null) { el.textContent = 'Sin datos (inicia sesión y abre el carro)'; return; }
    const s = cart.score;
    const color = s >= 7.5 ? RISK_COLORS[0] : s >= 5 ? RISK_COLORS[1] : s >= 2.5 ? RISK_COLORS[2] : RISK_COLORS[3];
    el.innerHTML = '<b style="color:' + color + '">' + fmt1(s) + '</b> / 10 · ' + cart.count + ' producto(s)';
  }

  // Construir chips de alérgenos
  const chipsEl = document.getElementById('allergens');
  ALLERGENS.forEach(([key, label]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'al';
    b.setAttribute('data-al', key);
    b.textContent = label;
    chipsEl.appendChild(b);
  });

  document.body.addEventListener('click', (ev) => {
    const seg = ev.target.closest('.seg button');
    if (seg) {
      settings[seg.parentElement.getAttribute('data-set')] = seg.getAttribute('data-v');
      save(); sync();
      return;
    }
    const al = ev.target.closest('.al');
    if (al) {
      const k = al.getAttribute('data-al');
      const i = settings.allergens.indexOf(k);
      if (i >= 0) settings.allergens.splice(i, 1); else settings.allergens.push(k);
      save(); sync();
    }
  });
  document.body.addEventListener('change', (ev) => {
    const cb = ev.target.closest('input[data-diet]');
    if (!cb) return;
    settings.diet[cb.getAttribute('data-diet')] = cb.checked;
    save();
  });

  chrome.storage.local.get(['mdnaSettings', 'mdnaCart']).then((o) => {
    if (o.mdnaSettings) settings = Object.assign({}, settings, o.mdnaSettings,
      { diet: Object.assign({}, settings.diet, o.mdnaSettings.diet || {}) });
    sync();
    renderCart(o.mdnaCart);
  });
})();
