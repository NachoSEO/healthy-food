// Se ejecuta con mcp__plugin_playwright_playwright__browser_evaluate en la pestaña
// de tienda.mercadona.es con la sesión iniciada. Devuelve las líneas del carro con
// nombre, categoría, precio, EAN e ingredientes ya resueltos.
//
// Requisitos: haber navegado a https://tienda.mercadona.es y estar logueado
// (existe localStorage['MO-user'] con token).
async () => {
  const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/^Ingredientes:\s*/i, '').trim();

  const user = JSON.parse(localStorage.getItem('MO-user') || 'null');
  const da = JSON.parse(localStorage.getItem('__mo_da') || '{}'); // {warehouse, postalCode}
  if (!user || !user.token) {
    return { error: 'NO_SESSION', hint: 'No hay sesión iniciada en Mercadona (falta MO-user.token).' };
  }
  const wh = da.warehouse || 'mad1';
  const auth = { 'Authorization': 'Bearer ' + user.token, 'Accept': 'application/json' };

  // 1) Carro del cliente
  const cartRes = await fetch(`/api/customers/${user.uuid}/cart/`, { headers: auth, credentials: 'include' });
  if (!cartRes.ok) return { error: 'CART_FETCH_FAILED', status: cartRes.status };
  const cart = await cartRes.json();

  // 2) Ingredientes por producto (necesita ?wh= o da 404)
  const items = [];
  for (const l of (cart.lines || [])) {
    const p = l.product || {};
    let ean = null, ingredients = '', allergens = '';
    try {
      const rd = await fetch(`/api/products/${p.id}/?lang=es&wh=${wh}`, { credentials: 'include' });
      if (rd.ok) {
        const d = await rd.json();
        const ni = d.nutrition_information || {};
        ean = d.ean || null;
        ingredients = strip(ni.ingredients);
        allergens = strip(ni.allergens);
      }
    } catch (e) {}
    items.push({
      id: p.id,
      name: p.display_name,
      ean,
      qty: l.quantity,
      price: p.price_instructions && p.price_instructions.unit_price,
      category: (p.categories || []).map(c => c.name).join(' / '),
      url: p.share_url || (`https://tienda.mercadona.es/product/${p.id}`),
      ingredients,
      allergens
    });
  }
  return { warehouse: wh, postalCode: da.postalCode || null, user: user.uuid, count: items.length, items };
};
