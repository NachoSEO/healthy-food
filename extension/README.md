# Semáforo Sano · Mercadona (extensión de Chrome)

Extensión que, mientras navegas por **tienda.mercadona.es**, pinta un **semáforo de salud** junto a
cada producto. Al pasar el ratón sobre el icono, muestra un tooltip con **qué aditivos lleva, su nivel
de riesgo y el efecto de salud** (con la fuente: EFSA, ANSES, IARC, Yuka).

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

- `src/hook.js` (mundo principal) intercepta las respuestas de la API de Mercadona para saber el **id**
  de cada producto que se muestra (los ids no están en el HTML de las tarjetas).
- `src/content.js` (mundo aislado) empareja cada tarjeta con su id, pide los ingredientes a
  `/api/products/{id}/?lang=es&wh=<almacén>`, detecta los aditivos (números E + nombres), los clasifica
  con `data/aditivos.json` y pinta el badge + tooltip.
- `data/aditivos.json` es la **misma base** que usan las skills (`~150` aditivos con riesgo, efecto y
  fuente). Editable: cambia un nivel de riesgo y se refleja en la extensión.

## Limitaciones
- Usa los ingredientes que expone Mercadona; algún producto nuevo puede no tenerlos (badge se omite).
- El nivel de evidencia varía por aditivo. **Informativo, no es consejo médico.**
- No añade NOVA/Nutri-Score (eso requiere Open Food Facts); las skills del repo sí lo hacen.
