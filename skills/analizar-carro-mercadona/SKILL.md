---
name: analizar-carro-mercadona
description: Analiza los productos del carro de Mercadona del usuario para detectar aditivos, procesamiento (NOVA) y calidad nutricional (Nutri-Score), con efectos de salud de cada aditivo de riesgo (estilo Yuka) y alternativas más sanas dentro de la propia tienda. Úsala cuando el usuario quiera "revisar/analizar su compra de Mercadona", "ver si sus productos son sanos", "mirar aditivos del carro" o similar. Requiere la sesión de Mercadona abierta en el navegador (Playwright MCP).
---

# Analizar carro de Mercadona

Revisa el carro real del usuario y emite un informe semáforo por producto:
🟢 sano · 🟡 aceptable · 🟠 mejor evitar · 🔴 evitar.

## Requisitos
- El **Playwright MCP** disponible (`mcp__plugin_playwright_playwright__*`).
- El usuario **logueado en `https://tienda.mercadona.es`** en la pestaña controlada por Playwright
  (existe `localStorage['MO-user'].token`). Si no lo está, pídele que inicie sesión en esa ventana.
- Python 3 (usa solo librería estándar; no requiere `pip`).

## Flujo

### 1. Asegurar la sesión
Navega a `https://tienda.mercadona.es` si hace falta (`browser_navigate`). Acepta el banner de
cookies si aparece. Comprueba la sesión con `browser_evaluate`:
`() => !!(JSON.parse(localStorage.getItem('MO-user')||'null')||{}).token`
Si es `false`, pide al usuario que inicie sesión en la ventana y espera su confirmación.

### 2. Leer el carro
Ejecuta el contenido de `scripts/read_cart.js` con `browser_evaluate` (pega la función tal cual).
Devuelve `{warehouse, postalCode, count, items:[{id,name,ean,price,qty,category,ingredients,allergens}]}`.
- Clave técnica: el carro se obtiene con `GET /api/customers/{uuid}/cart/` + `Authorization: Bearer <token>`.
- Los ingredientes salen de `GET /api/products/{id}/?lang=es&wh={warehouse}` — **el parámetro `wh` es
  obligatorio** o devuelve 404.

### 3. Buscar alternativas (para los 🟡/🟠/🔴)
Antes de generar el informe, para cada producto que no sea 🟢 busca una alternativa más limpia en su
misma categoría y **añádela al item** en el campo `alternatives`:
- Con la sesión activa, usa `browser_evaluate` para recorrer `GET /api/categories/{id}/?lang=es&wh={wh}`
  de la categoría del producto, o busca por término.
- Prioriza productos con **menos aditivos de riesgo** e ingredientes reconocibles; confirma leyendo sus
  ingredientes con `/api/products/{id}/?lang=es&wh={wh}`.
- Cada alternativa: `{name, price, url, reason}`. La `url` es `https://tienda.mercadona.es/product/{id}`.

### 4. Analizar y generar el informe
Guarda el JSON (con las alternativas incrustadas) y ejecuta según el formato deseado:
```
python3 scripts/analyze.py cart.json                    # markdown por stdout
python3 scripts/analyze.py cart.json --html informe.html    # HTML autónomo (abrir en navegador)
python3 scripts/analyze.py cart.json --artifact frag.html   # fragmento para el tool Artifact
python3 scripts/analyze.py cart.json --json datos.json      # datos crudos
```
El script:
- Cruza cada producto con **Open Food Facts** por EAN (NOVA, Nutri-Score, aditivos).
- Detecta aditivos también parseando los ingredientes de Mercadona (E-números + palabras clave).
- Clasifica cada aditivo por riesgo (`elevado/moderado/limitado/ninguno`) con `config/aditivos.json`,
  mostrando **efectos de salud y fuente** (EFSA, ANSES, IARC, Yuka).
- Emite un veredicto semáforo por producto, con **enlaces al producto y a las alternativas**.

**Salida HTML recomendada:** genera con `--artifact` y publícala con el tool **Artifact** para dar al
usuario un enlace navegable; o con `--html` y ábrela localmente (`open informe.html`).

## Personalización
`config/aditivos.json` es editable: el usuario puede subir/bajar el riesgo de un aditivo, añadir efectos
o mover E-números entre niveles. La skill respeta esos cambios sin tocar código.

## Notas
- Es informativo, **no consejo médico**; el nivel de evidencia varía por aditivo (se cita la fuente).
- Si un producto no está en Open Food Facts y Mercadona no expone ingredientes (raro), avísalo como
  "sin datos" en vez de asumir que es sano.
- Cosmética/limpieza del carro se pueden omitir del análisis nutricional (no llevan `nutrition_information`).
