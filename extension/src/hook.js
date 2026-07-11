// Se ejecuta en el MUNDO PRINCIPAL de la página (world: MAIN).
// Envuelve window.fetch para capturar las respuestas de la API de Mercadona que
// contienen productos (listados, home, búsqueda) y extraer su {id, nombre, thumbnail}.
// Esos datos se envían al content script (mundo aislado) por postMessage, que los usa
// para saber qué id corresponde a cada tarjeta de producto renderizada.
(function () {
  if (window.__mdnaSemHook) return;
  window.__mdnaSemHook = true;

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
      if (url && url.indexOf('/api/') >= 0) {
        p.then((res) => {
          res.clone().json().then((data) => {
            const acc = [];
            collect(data, acc, 0);
            if (acc.length) window.postMessage({ __mdnaSem: 1, products: acc }, '*');
          }).catch(() => {});
        }).catch(() => {});
      }
    } catch (e) { /* noop */ }
    return p;
  };

  // Recorre recursivamente cualquier respuesta JSON y recoge objetos "producto".
  function collect(o, acc, depth) {
    if (!o || typeof o !== 'object' || depth > 9) return;
    if (o.id != null && o.display_name && (o.thumbnail || o.price_instructions || o.packaging)) {
      acc.push({ id: String(o.id), name: o.display_name, thumb: o.thumbnail || '' });
    }
    if (Array.isArray(o)) {
      for (let i = 0; i < o.length; i++) collect(o[i], acc, depth + 1);
    } else {
      for (const k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) collect(o[k], acc, depth + 1);
      }
    }
  }
})();
