// Se ejecuta en el MUNDO PRINCIPAL de la página (world: MAIN).
// Envuelve window.fetch y XMLHttpRequest para capturar las respuestas de la API de
// Mercadona (listados, home) y de Algolia (búsqueda) que contienen productos, y extraer
// su {id, nombre, thumbnail}. Esos datos se envían al content script (mundo aislado)
// por postMessage, que los usa para emparejar cada tarjeta renderizada con su id.
(function () {
  if (window.__mdnaSemHook) return;
  window.__mdnaSemHook = true;

  let lastWh = null;
  const buffer = [];      // productos vistos, para reenviar cuando el content script salude
  const MAX_BUFFER = 3000;

  function post(products) {
    window.postMessage({ __mdnaSem: 1, wh: lastWh, products: products || [] }, '*');
  }

  // Detecta el almacén (wh) que usa la propia web: del parámetro ?wh= de su API,
  // del índice de Algolia (products_prod_<wh>_es) de la búsqueda, o del centerCode
  // que la web manda a featureflags.mercadona.es.
  function sniffWh(url) {
    const m = /[?&]wh=([a-z0-9]+)/i.exec(url)
      || /\/indexes\/products_prod_([a-z0-9]+)_/i.exec(url)
      || /[?&]properties(?:%5B|\[)centerCode(?:%5D|\])=([a-z0-9]+)/i.exec(url);
    if (m && m[1] !== lastWh) { lastWh = m[1]; post([]); }
  }

  function interesting(url) {
    return !!url && (url.indexOf('/api/') >= 0 || url.indexOf('algolia') >= 0);
  }

  function harvest(data) {
    const acc = [];
    collect(data, acc, 0);
    if (!acc.length) return;
    for (let i = 0; i < acc.length; i++) buffer.push(acc[i]);
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    post(acc);
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
      if (interesting(url)) {
        sniffWh(url);
        p.then((res) => {
          res.clone().json().then(harvest).catch(() => {});
        }).catch(() => {});
      }
    } catch (e) { /* noop */ }
    return p;
  };

  // La búsqueda (Algolia) usa XMLHttpRequest, no fetch.
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__mdnaUrl = typeof url === 'string' ? url : String(url);
    return origOpen.apply(this, arguments);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    try {
      if (interesting(xhr.__mdnaUrl)) {
        sniffWh(xhr.__mdnaUrl);
        xhr.addEventListener('load', () => {
          try {
            const data = xhr.responseType === 'json'
              ? xhr.response
              : (!xhr.responseType || xhr.responseType === 'text') ? JSON.parse(xhr.responseText) : null;
            if (data) harvest(data);
          } catch (e) { /* respuesta no JSON */ }
        });
      }
    } catch (e) { /* noop */ }
    return origSend.apply(this, arguments);
  };

  // El content script carga más tarde (document_idle): cuando salude, reenvíale todo lo
  // capturado hasta entonces (wh + productos). Sin esto, en la carga directa de una ficha
  // de producto el wh se enviaba antes de que nadie escuchara y el semáforo nunca salía.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__mdnaSemHello) return;
    post(buffer);
  });

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
