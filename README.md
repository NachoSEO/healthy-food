# healthy-food

Herramientas para hacer una compra sana en Mercadona: analizar aditivos, procesamiento (NOVA) y
calidad nutricional (Nutri-Score) de los productos, con efectos de salud por aditivo (estilo Yuka) y
sustitución automática por alternativas más limpias. Pensado como **skills de Claude Code** que se
apoyan en la sesión del navegador (Playwright) y en Open Food Facts.

## Skills

### `skills/analizar-carro-mercadona`
Analiza el carro de Mercadona que has montado tú a mano: lee el carro desde tu sesión, saca los
ingredientes de cada producto, detecta aditivos y clasifica NOVA / Nutri-Score, y propone alternativas
más limpias. Salida en Markdown o HTML.

- `SKILL.md` — flujo.
- `scripts/read_cart.js` — lee el carro desde `localStorage` + API del cliente.
- `scripts/analyze.py` — cruza con Open Food Facts, clasifica aditivos y genera el informe (`--html`, `--artifact`, `--json`).
- `config/aditivos.json` — base de ~150 aditivos con nivel de riesgo, efecto de salud y fuente (EFSA, ANSES, IARC, Yuka). **Editable.**

### `skills/compra-mercadona-menu`
Compra asistida a partir de un **menú**: genera la lista, busca los productos en el catálogo del
almacén, analiza cada uno, sustituye lo problemático por alternativas limpias y lo **añade al carrito
real**. Reutiliza el motor de la skill anterior.

- `SKILL.md` — flujo.
- `scripts/build_catalog.py` — índice del catálogo por categorías para un almacén (`wh`).
- `scripts/add_to_cart.js` — añade al carro vía `PUT /api/customers/{uuid}/cart/` **y verifica** que persiste.
- `scripts/report.py` — informe HTML agrupado con semáforo, precios, enlaces y cambios por salud.

### `extension/` — Semáforo Sano (extensión de Chrome)
Extensión Manifest V3 que, mientras navegas por `tienda.mercadona.es`, pinta un **semáforo de salud
junto a cada producto**; al pasar el ratón muestra aditivos, riesgo y efectos. Reutiliza la misma base
`data/aditivos.json`. Instalación en `extension/README.md` (Cargar descomprimida en `chrome://extensions`).

## Clasificación de riesgo (estilo Yuka)

| Nivel | Significado |
|-------|-------------|
| 🟢 ninguno | Sin riesgo conocido / origen natural |
| 🟡 limitado | Riesgo menor o solo en consumo alto / sensibles |
| 🟠 moderado | Sospecha razonable con estudios |
| 🔴 elevado | Evidencia seria de daño o prohibido por reguladores |

Configuración estricta activada: **emulgentes y espesantes procesados = riesgo elevado**; gomas
naturales (guar, garrofín, pectina) = limitado (criterio Yuka 2024).

## Notas de uso
- Requiere sesión iniciada en `https://tienda.mercadona.es` en el navegador controlado por Playwright.
- El almacén (`wh`, p. ej. `bcn1`) lo determina la dirección de entrega; va en todas las llamadas a la API.
- **Cantidad = unidades del producto** (un pack de 6 briks es `1`, no `6`).
- Frescos a peso variable pueden no persistir en el carro vía API: verificar tras añadir.
- Informativo, **no es consejo médico**; el nivel de evidencia varía por aditivo.

## Menú de ejemplo
`menu/menu-2-semanas.md` — menú mediterráneo de verano (2 adultos + 1 niño) usado para probar la compra asistida.
