---
name: compra-mercadona-menu
description: Compra asistida y genérica en Mercadona a partir de un menú. PREGUNTA PRIMERO por los comensales (adultos/niños), qué comidas cubrir, duración y exclusiones; con eso escala las cantidades. Busca los productos en el catálogo del almacén del usuario, analiza cada uno con el motor de aditivos/NOVA/Nutri-Score, sustituye automáticamente los que salen 🔴/🟠 por alternativas más limpias y los añade al carrito real. Úsala cuando el usuario quiera "hazme la compra del menú", "monta el carrito de Mercadona", "compra asistida". Requiere sesión de Mercadona abierta (Playwright MCP). Reutiliza el motor de la skill analizar-carro-mercadona.
---

# Compra asistida de Mercadona desde un menú

Convierte un menú en un carrito de Mercadona, validando la salud de cada producto y
cambiando por alternativas más limpias lo problemático. **Es un superconjunto de la skill
`analizar-carro-mercadona`**, que se mantiene aparte para cuando el usuario compra a mano.

## Requisitos
- Playwright MCP + sesión iniciada en `https://tienda.mercadona.es` (`localStorage['MO-user'].token`).
- Almacén correcto (se determina por la dirección de entrega / CP del usuario). **Confírmalo siempre.**
- Python 3 (solo librería estándar).
- El motor de análisis de `~/.claude/skills/analizar-carro-mercadona/` (`scripts/analyze.py`, `config/aditivos.json`).

## Flujo

### 0. Preguntar SIEMPRE antes de nada (parámetros de la compra)
Nunca asumas comensales ni raciones. Usa **AskUserQuestion** para recoger, como mínimo:
- **¿Para cuántos?** nº de **adultos** y nº de **niños** (y edad aprox., que come menos ración).
- **¿Qué comidas cubrir?** desayuno / comida / merienda / cena, y en qué días (p. ej. el niño solo cena
  entre semana; alguien come de tupper en el trabajo…).
- **¿Cuántos días / semanas?** (1 semana, 2 semanas…).
- **¿Exclusiones?** qué NO comprar en Mercadona (p. ej. fruta o verdura que compran en la frutería),
  alergias/intolerancias, alimentos que no gustan, dieta (mediterránea, veggie…).
- **¿Presupuesto o marca?** opcional (p. ej. preferir Hacendado, o marcas concretas).

Guarda estos parámetros; **de ellos salen las cantidades** (ver paso 3). Si el usuario ya ha dado el
menú y los comensales, no vuelvas a preguntar lo que ya sabes.

### 1. Confirmar sesión y almacén
`browser_evaluate`: leer `MO-user.token` y el almacén efectivo. El almacén va en TODAS las
llamadas como `?wh=<almacen>` (p. ej. `bcn1`). Sin el `wh` correcto, las fichas de producto dan 404.

### 2. Construir el catálogo (`scripts/build_catalog.py`)
Recorre las categorías de alimentación con `GET /api/categories/{id}/?lang=es&wh=<wh>` y guarda un
índice `catalog.json` con `{id, name, subcat, price}`. La búsqueda Algolia de la web NO resuelve desde
el navegador headless, por eso se navega por categorías.

### 3. Traducir el menú a lista de la compra
Deriva ingredientes + **cantidades** del menú **escaladas a los comensales del paso 0**. No uses
números fijos; calcula raciones:
- **Raciones por comida** = `adultos + Σ(factor_niño)`, con `factor_niño ≈ 0,5` (3-6 años) a `0,75`
  (7-12). Aplica solo a las comidas/días que el usuario dijo cubrir (p. ej. si el niño solo cena entre
  semana, cuéntalo únicamente en esas cenas).
- **Nº de comidas** = días × comidas cubiertas. De ahí salen las raciones totales de cada tipo de plato
  (legumbre, pescado, carne, huevo…) y, con el tamaño de ración estándar, las **unidades a comprar**.
- Redondea al formato de venta y ajusta a la despensa (AOVE, sal, especias duran varias compras → 1 ud.).

Empareja cada ítem con el catálogo por palabras clave
(prioriza marca Hacendado y variantes simples). Revisa los emparejamientos: el matcher confunde
"tomate"→"mermelada de tomate", "sal"→"sardinillas en sal", "calabacín"→"crema de calabacín", etc.
**Verifica cada línea por nombre antes de continuar.**

⚠️ **Semántica de cantidad (IMPORTANTE):** `quantity` = número de **unidades del producto tal como se
vende**. Un "pack de 6 briks de leche" es `quantity: 1`, NO 6. Confunde fácilmente pack vs unidad
(error real cometido: leche `x6` metió 6 packs en vez de 6 briks). Comprueba el formato del producto
(`price_instructions`, nombre) y ajusta.

### 4. Analizar y sustituir (motor de aditivos)
Descarga ingredientes de cada producto (`/api/products/{id}/?lang=es&wh=<wh>`), monta un
`cart_menu.json` con `items:[{id,name,ean,price,qty,ingredients,...}]` y ejecuta
`python3 ../analizar-carro-mercadona/scripts/analyze.py cart_menu.json --json analisis.json`.
Para cada producto 🔴/🟠, busca en su misma categoría una alternativa con menos aditivos de riesgo
(confirma leyendo sus ingredientes) y sustitúyela, guardando `swapped_from`.

### 5. Añadir al carrito (`scripts/add_to_cart.js`)
Endpoint: **PUT** `/api/customers/{uuid}/cart/?lang=es&wh=<wh>` con el carro completo
`{id, version, lines:[{quantity, product_id, sources:['+NA']}]}`. Se hace GET del carro, se fusionan las
líneas nuevas (set cantidad; preservar `version`/`sources` de las existentes) y se PUT.

⚠️ **Verificación obligatoria (lección aprendida):** el PUT puede devolver 200 con todas las líneas,
pero al re-hacer GET **algunos productos no persisten** (frescos a peso / granel, y a veces variantes de
packaging). Tras el PUT, **vuelve a leer el carro y compara**: informa de los que no se quedaron y, si
procede, añádelos desde la UI (botón "Añadir al carro") o avisa al usuario. Nunca asumas que el PUT=OK
significa que todo entró.

### 6. Informe (`scripts/report.py`)
Genera un HTML agrupado por secciones con semáforo, cantidad, precio, enlaces al producto y los cambios
por salud. Publícalo con el tool **Artifact** y avisa al usuario para que revise el carrito ANTES de
confirmar el pedido. **No confirmes nunca el pedido tú.**

## Notas y límites
- No añadas categorías que el usuario compra en otro sitio (p. ej. fruta/verdura en frutería). Pregúntalo.
- Frescos a peso variable: la cantidad es orientativa; se ajusta al pesar.
- Legumbre en bote de Mercadona: todas llevan E385 (EDTA) + sulfitos/vit C (riesgo limitado). Si el
  usuario quiere 0 aditivos, ofrecer legumbre **seca** (sin aditivos) u otra marca en tarro de cristal.
- Mantén intacta la skill `analizar-carro-mercadona` para el análisis puro de un carro hecho a mano.
