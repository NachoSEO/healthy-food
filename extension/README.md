# Semáforo Sano · Mercadona (extensión de Chrome)

Extensión que, mientras navegas por **tienda.mercadona.es**, pinta un **semáforo de salud** junto a
cada producto. Al pasar el ratón sobre el icono, muestra un tooltip con **qué aditivos lleva, su nivel
de riesgo y el efecto de salud** (con la fuente: EFSA, ANSES, IARC, Yuka).

Funciona en **categorías, búsqueda** (Algolia) **y en la ficha de producto**, donde además del badge
se muestra un panel fijo con el detalle bajo el título.

## Colores

| Color | Significado |
|-------|-------------|
| 🟢 Verde | Sin aditivos, o solo aditivos inocuos |
| 🟡 Amarillo | Aditivos de riesgo limitado (comunes) |
| 🟠 Naranja | Aditivos con sospecha de daño (estudios) |
| 🔴 Rojo | Aditivos de riesgo elevado (o prohibidos) |

Criterio estricto: emulgentes/espesantes procesados = riesgo elevado; gomas naturales (guar, pectina) = limitado (Yuka 2024).

## Instalación (modo desarrollador)

1. Abre Chrome y ve a `chrome://extensions`.
2. Activa **"Modo de desarrollador"** (arriba a la derecha).
3. Pulsa **"Cargar descomprimida"** y selecciona esta carpeta `extension/`.
4. Entra en `https://tienda.mercadona.es` y navega: verás un punto de color junto a cada producto.
   Pasa el ratón por encima para ver el detalle.

## Cómo funciona

- `src/hook.js` (mundo principal) intercepta las respuestas de la API de Mercadona (`fetch`) **y de
  Algolia** (`XMLHttpRequest`, usado por la búsqueda) para saber el **id** de cada producto que se
  muestra (los ids no están en el HTML de las tarjetas). Detecta el almacén (`wh`) del parámetro
  `?wh=`, del índice de Algolia o del `centerCode` de featureflags, y guarda lo capturado para
  reenviarlo cuando el content script salude (imprescindible al cargar directamente una ficha).
- `src/content.js` (mundo aislado) empareja cada tarjeta con su id y pide los ingredientes a
  `/api/products/{id}/?lang=es&wh=<almacén>` (con fallback sin `wh`). Solo pide las fichas de las
  tarjetas **visibles** (IntersectionObserver) y con una **cola limitada** (la API corta ráfagas
  con 403). Detecta los aditivos (números E + nombres), los clasifica con `data/aditivos.json` y
  pinta el badge + tooltip; en `/product/{id}` añade también un panel fijo bajo el título.
- El tooltip se posiciona respecto al viewport: se voltea hacia arriba si no cabe debajo y, si no
  cabe entero, se limita con scroll interno (se puede meter el ratón dentro).
- `data/aditivos.json` es la **misma base** que usan las skills (`~150` aditivos con riesgo, efecto y
  fuente). Editable: cambia un nivel de riesgo y se refleja en la extensión.

## Limitaciones
- Usa los ingredientes que expone Mercadona; algún producto nuevo puede no tenerlos (badge se omite).
- El nivel de evidencia varía por aditivo. **Informativo, no es consejo médico.**
- No añade NOVA/Nutri-Score (eso requiere Open Food Facts); las skills del repo sí lo hacen.

## Roadmap (ideas analizadas)

1. **Nutri-Score y NOVA en el tooltip** — la ficha de la API trae el `ean`; con él se puede consultar
   Open Food Facts (`world.openfoodfacts.org/api/v2/product/{ean}`) y añadir nota nutricional y grado
   de procesamiento. Requiere `host_permissions` extra y caché local (`chrome.storage`).
2. **Azúcar/sal/grasas saturadas por 100 g** — ya vienen en `nutrition_information` de la misma
   respuesta que usamos; pintarlas en el tooltip es gratis (sin peticiones extra).
3. **Filtros de salud** — atenuar u ocultar los 🔴/🟠 en listados, u ordenar la categoría por semáforo.
4. **Alerta de alérgenos personalizada** — el usuario marca sus alérgenos en un popup de la extensión
   y el badge avisa (borde parpadeante) si el producto los contiene (`nutrition_information.allergens`).
5. **"Ver alternativa más sana"** — botón en el tooltip que busca en la misma categoría un producto
   más limpio (la lógica ya existe en las skills del repo).
6. **Nota media del carrito** — badge en el icono de la cesta con la media de la compra actual.
7. **Multi-supermercado** — arquitectura de adaptadores por tienda (detección de tarjetas + API de
   ingredientes por súper) reutilizando el mismo motor de clasificación:
   - **Carrefour, Dia, Alcampo, Eroski, Consum**: tienda online propia; habría que mapear su API/HTML.
   - **Lidl/Aldi**: sin ingredientes online fiables → fallback por EAN con Open Food Facts.
   - El manifest pasaría a `content_scripts` por dominio con un módulo `adapters/<super>.js`.
