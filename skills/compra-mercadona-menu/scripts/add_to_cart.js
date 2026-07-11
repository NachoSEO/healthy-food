// Añade productos al carrito de Mercadona y VERIFICA que se han quedado.
// Ejecutar con mcp__plugin_playwright_playwright__browser_evaluate en la pestaña
// de tienda.mercadona.es con sesión iniciada. Sustituye ADDS y WH antes de ejecutar,
// o adapta para recibirlos inyectados en el propio cuerpo de la función.
//
// Endpoint real: PUT /api/customers/{uuid}/cart/?lang=es&wh=<wh>
// Cuerpo: { id, version, lines:[{quantity, product_id, sources:['+NA'], version?}] }
//
// LECCIÓN CLAVE: el PUT puede responder 200 con todas las líneas, pero al re-leer el
// carro algunos productos NO persisten (frescos a peso / granel, algunas variantes de
// packaging). Por eso esta función RE-LEE el carro y devuelve `notPersisted`.
async () => {
  const WH = 'bcn1';
  // adds: [{product_id, quantity}]  — quantity = nº de unidades DEL PRODUCTO (un pack = 1)
  const ADDS = [/* {product_id:"18018", quantity:2}, ... */];

  const user = JSON.parse(localStorage.getItem('MO-user'));
  const auth = { 'Authorization': 'Bearer ' + user.token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const base = `/api/customers/${user.uuid}/cart/?lang=es&wh=${WH}`;

  const cart = await (await fetch(base, { headers: auth, credentials: 'include' })).json();
  const lines = (cart.lines || []).map(l => ({
    quantity: l.quantity, product_id: String(l.product.id),
    sources: l.sources || ['+NA'], version: l.version
  }));
  const idx = {}; lines.forEach((l, i) => idx[l.product_id] = i);
  for (const a of ADDS) {
    const id = String(a.product_id);
    if (idx[id] != null) lines[idx[id]].quantity = a.quantity;
    else { lines.push({ quantity: a.quantity, product_id: id, sources: ['+NA'] }); idx[id] = lines.length - 1; }
  }
  const put = await fetch(base, { method: 'PUT', headers: auth, credentials: 'include',
    body: JSON.stringify({ id: cart.id, version: cart.version, lines }) });
  if (!put.ok) return { ok: false, status: put.status, error: (await put.text()).slice(0, 300) };

  // VERIFICAR: re-leer y comparar
  const after = await (await fetch(base, { headers: auth, credentials: 'include' })).json();
  const inCart = new Set((after.lines || []).map(l => String(l.product.id)));
  const notPersisted = ADDS.map(a => String(a.product_id)).filter(id => !inCart.has(id));
  return { ok: true, requested: ADDS.length, inCartCount: inCart.size, notPersisted };
};
