#!/usr/bin/env python3
"""
Analiza los productos de un carro de Mercadona: detecta aditivos, obtiene NOVA y
Nutri-Score (Open Food Facts) y emite un veredicto semáforo por producto, con los
efectos de salud de cada aditivo de riesgo (estilo Yuka) y enlaces a los productos.

Uso:
    python3 analyze.py cart.json                    # informe markdown por stdout
    python3 analyze.py cart.json --html informe.html    # HTML autónomo (abrible en navegador)
    python3 analyze.py cart.json --artifact frag.html   # fragmento para el tool Artifact
    python3 analyze.py cart.json --json datos.json      # datos crudos

cart.json = salida de read_cart.js. Cada item admite además, opcionalmente:
    "url": enlace al producto en Mercadona
    "alternatives": [{"name","price","url","reason"}]  (mejores opciones ya localizadas)
"""
import sys, json, re, os, html, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, '..', 'config', 'aditivos.json'), encoding='utf-8'))
UA = {'User-Agent': 'HealthyCart/1.0 (personal use)'}
DB = {k.upper(): v for k, v in CFG['aditivos'].items()}
KEYWORDS = CFG['palabras_clave']

E_RE = re.compile(r'\bE[\s-]?(\d{3,4}[a-z]?)\b', re.IGNORECASE)
RISK_ORDER = {'elevado': 3, 'moderado': 2, 'limitado': 1, 'ninguno': 0, 'desconocido': 1}
RISK_DOT = {'elevado': '🔴', 'moderado': '🟠', 'limitado': '🟡', 'ninguno': '🟢', 'desconocido': '⚪'}
# icono, etiqueta, clave de color css
VERDICT = {
    'evitar':  ('🔴', 'EVITAR', 'red'),
    'mejor':   ('🟠', 'MEJOR EVITAR', 'orange'),
    'acept':   ('🟡', 'ACEPTABLE', 'yellow'),
    'sano':    ('🟢', 'SANO', 'green'),
}


def off_lookup(ean):
    if not ean:
        return {}
    url = (f'https://world.openfoodfacts.org/api/v2/product/{ean}'
           '?fields=additives_tags,additives_n,nova_group,nutriscore_grade,ingredients_text,product_name')
    for _ in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
                d = json.load(r)
            return d.get('product', {}) if d.get('status') == 1 else {}
        except Exception:
            continue
    return {}


def additives_from_text(ingredients):
    found = set()
    for m in E_RE.finditer(ingredients or ''):
        found.add('E' + m.group(1).upper())
    low = (ingredients or '').lower()
    for kw, e in KEYWORDS.items():
        if not kw.startswith('_') and kw in low:
            found.add(e.upper())
    return found


def classify(e):
    info = DB.get(e.upper())
    if info:
        return {'e': e.upper(), 'nombre': info['nombre'], 'tipo': info.get('tipo', ''),
                'riesgo': info['riesgo'], 'efectos': info.get('efectos', ''), 'fuente': info.get('fuente', '')}
    return {'e': e.upper(), 'nombre': 'Aditivo no catalogado', 'tipo': '',
            'riesgo': 'desconocido', 'efectos': 'Sin ficha en la base local; revisar manualmente.', 'fuente': ''}


def verdict(nova, additives):
    worst = max((RISK_ORDER[a['riesgo']] for a in additives), default=0)
    if worst == 3:
        return VERDICT['evitar'] + ('Contiene aditivos de riesgo elevado',)
    if worst == 2:
        return VERDICT['mejor'] + ('Contiene aditivos con sospecha de daño (estudios)',)
    if worst == 1:
        return VERDICT['acept'] + ('Aditivos de riesgo limitado / comunes',)
    if additives:
        return VERDICT['sano'] + ('Solo aditivos inocuos (origen natural)',)
    if nova and nova >= 4:
        return VERDICT['acept'] + ('Ultraprocesado (NOVA 4) pero sin aditivos detectados',)
    return VERDICT['sano'] + ('Sin aditivos',)


def product_url(it):
    if it.get('url'):
        return it['url']
    if it.get('id'):
        return f"https://tienda.mercadona.es/product/{it['id']}"
    return None


def analyze_item(it):
    off = off_lookup(it.get('ean'))
    off_e = set()
    for t in off.get('additives_tags', []) or []:
        m = re.search(r'e(\d{3,4}[a-z]?)', t, re.IGNORECASE)
        if m:
            off_e.add('E' + m.group(1).upper())
    all_e = sorted(off_e | additives_from_text(it.get('ingredients')),
                   key=lambda x: (int(re.sub(r'[^0-9]', '', x) or 0), x))
    additives = [classify(e) for e in all_e]
    additives.sort(key=lambda a: -RISK_ORDER[a['riesgo']])
    nova = off.get('nova_group')
    nutri = (off.get('nutriscore_grade') or '').upper() or None
    icon, tag, color, reason = verdict(nova, additives)
    return {**{k: it.get(k) for k in ('id', 'name', 'ean', 'price', 'qty', 'category', 'ingredients')},
            'url': product_url(it), 'alternatives': it.get('alternatives') or [],
            'nova': nova, 'nutriscore': nutri, 'additives': additives, 'off_found': bool(off),
            'icon': icon, 'verdict': tag, 'color': color, 'reason': reason}


# --------------------------- salida markdown ---------------------------
def markdown(results, meta):
    L = ["# 🛒 Análisis del carro de Mercadona"]
    if meta.get('postalCode'):
        L.append(f"_Entrega en {meta['postalCode']} · almacén {meta.get('warehouse','?')} · {len(results)} productos_\n")
    order = {'red': 0, 'orange': 1, 'yellow': 2, 'green': 3}
    for r in sorted(results, key=lambda x: order.get(x['color'], 4)):
        price = f"{r['price']} €" if r.get('price') else ""
        L.append(f"## {r['icon']} {r['name']} — {price}  ·  **{r['verdict']}**")
        badges = [b for b in [f"Nutri-Score {r['nutriscore']}" if r['nutriscore'] else None,
                              f"NOVA {r['nova']}" if r['nova'] else None] if b]
        if badges:
            L.append(' · '.join(badges))
        if r['ingredients']:
            L.append(f"- **Ingredientes:** {r['ingredients']}")
        if r['additives']:
            L.append("- **Aditivos:**")
            for a in r['additives']:
                line = f"    - {RISK_DOT[a['riesgo']]} **{a['e']} {a['nombre']}** (riesgo {a['riesgo']})"
                if a['efectos']:
                    line += f" — {a['efectos']}"
                if a['fuente']:
                    line += f" _[{a['fuente']}]_"
                L.append(line)
        else:
            L.append("- **Aditivos:** ninguno ✅")
        L.append(f"- _{r['reason']}_")
        for alt in r['alternatives']:
            u = f" ({alt['url']})" if alt.get('url') else ""
            pr = f" — {alt['price']} €" if alt.get('price') else ""
            L.append(f"  - 🔄 Alternativa: **{alt['name']}**{pr}{u} · {alt.get('reason','')}")
        L.append("")
    n = lambda c: sum(1 for r in results if r['color'] == c)
    L.append("---")
    L.append(f"**Resumen:** 🟢 {n('green')} sanos · 🟡 {n('yellow')} aceptables · 🟠 {n('orange')} mejor evitar · 🔴 {n('red')} a evitar")
    L.append("\n_Informativo, no es consejo médico. El nivel de evidencia varía por aditivo (se cita la fuente: EFSA, ANSES, IARC…)._")
    return '\n'.join(L)


# ----------------------------- salida HTML -----------------------------
CSS = """
:root{
  --bg:#f5f8f3; --panel:#ffffff; --ink:#1a241d; --muted:#5c6b5f; --line:#e3ebdf;
  --accent:#2f9e63; --tab:tabular-nums;
  --green:#2f9e63; --yellow:#c99512; --orange:#dd6f2c; --red:#cf4436;
  --green-bg:#e8f5ec; --yellow-bg:#fbf3dc; --orange-bg:#fbe9db; --red-bg:#fbe4e1;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#10140e; --panel:#1a1f17; --ink:#e9eee6; --muted:#9aa896; --line:#2b3327;
    --accent:#4cc584;
    --green:#4cc584; --yellow:#e0b640; --orange:#ef8b4c; --red:#e5645a;
    --green-bg:#16281d; --yellow-bg:#2a2413; --orange-bg:#2c2015; --red-bg:#2d1a18;
  }
}
:root[data-theme="light"]{
  --bg:#f5f8f3; --panel:#ffffff; --ink:#1a241d; --muted:#5c6b5f; --line:#e3ebdf; --accent:#2f9e63;
  --green:#2f9e63; --yellow:#c99512; --orange:#dd6f2c; --red:#cf4436;
  --green-bg:#e8f5ec; --yellow-bg:#fbf3dc; --orange-bg:#fbe9db; --red-bg:#fbe4e1;
}
:root[data-theme="dark"]{
  --bg:#10140e; --panel:#1a1f17; --ink:#e9eee6; --muted:#9aa896; --line:#2b3327; --accent:#4cc584;
  --green:#4cc584; --yellow:#e0b640; --orange:#ef8b4c; --red:#e5645a;
  --green-bg:#16281d; --yellow-bg:#2a2413; --orange-bg:#2c2015; --red-bg:#2d1a18;
}
*{box-sizing:border-box}
.hc{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  color:var(--ink);background:var(--bg);line-height:1.5;
  -webkit-font-smoothing:antialiased;padding:32px 20px 64px;max-width:820px;margin:0 auto}
.hc h1{font-size:1.7rem;font-weight:700;letter-spacing:-.02em;margin:0 0 4px;text-wrap:balance}
.hc .sub{color:var(--muted);font-size:.9rem;margin-bottom:22px}
.hc .summary{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:26px}
.hc .stat{display:flex;align-items:center;gap:8px;padding:8px 13px;border:1px solid var(--line);
  border-radius:11px;background:var(--panel);font-size:.86rem;font-weight:600}
.hc .stat .n{font-variant-numeric:var(--tab);font-size:1.05rem}
.hc .dot{width:10px;height:10px;border-radius:50%;flex:0 0 auto}
.dot.green{background:var(--green)} .dot.yellow{background:var(--yellow)}
.dot.orange{background:var(--orange)} .dot.red{background:var(--red)} .dot.gray{background:var(--muted)}
.hc .card{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:15px;
  padding:18px 20px 18px 22px;margin-bottom:15px;overflow:hidden}
.hc .card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px}
.card.green::before{background:var(--green)} .card.yellow::before{background:var(--yellow)}
.card.orange::before{background:var(--orange)} .card.red::before{background:var(--red)}
.hc .chead{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
.hc .cname{font-size:1.12rem;font-weight:650;letter-spacing:-.01em;text-decoration:none;color:var(--ink)}
.hc .cname:hover{color:var(--accent);text-decoration:underline}
.hc .price{font-variant-numeric:var(--tab);font-weight:700;font-size:1.05rem;white-space:nowrap}
.hc .verdict{display:inline-flex;align-items:center;gap:6px;font-size:.72rem;font-weight:700;
  letter-spacing:.06em;padding:4px 9px;border-radius:999px;margin-top:6px}
.verdict.green{background:var(--green-bg);color:var(--green)}
.verdict.yellow{background:var(--yellow-bg);color:var(--yellow)}
.verdict.orange{background:var(--orange-bg);color:var(--orange)}
.verdict.red{background:var(--red-bg);color:var(--red)}
.hc .badges{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 2px}
.hc .badge{font-size:.72rem;font-weight:600;color:var(--muted);border:1px solid var(--line);
  padding:2px 8px;border-radius:6px}
.hc .ingredients{font-size:.83rem;color:var(--muted);margin:10px 0 4px}
.hc .adds{list-style:none;padding:0;margin:12px 0 4px;display:flex;flex-direction:column;gap:9px}
.hc .add{display:flex;gap:9px;font-size:.85rem;align-items:baseline}
.hc .add .an{font-weight:650}
.hc .add .ae{color:var(--muted)}
.hc .add .src{color:var(--muted);font-style:italic;font-size:.78rem}
.hc .reason{font-size:.82rem;color:var(--muted);font-style:italic;margin-top:10px}
.hc .none{font-size:.85rem;color:var(--green);font-weight:600;margin-top:8px}
.hc .alts{margin-top:14px;padding-top:13px;border-top:1px dashed var(--line);display:flex;
  flex-direction:column;gap:8px}
.hc .alts .lbl{font-size:.72rem;font-weight:700;letter-spacing:.06em;color:var(--muted);text-transform:uppercase}
.hc .alt{display:flex;justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap;
  background:var(--green-bg);border-radius:9px;padding:9px 12px}
.hc .alt a{font-weight:650;color:var(--accent);text-decoration:none}
.hc .alt a:hover{text-decoration:underline}
.hc .alt .why{font-size:.8rem;color:var(--muted);flex:1 1 100%}
.hc .foot{margin-top:26px;font-size:.76rem;color:var(--muted);border-top:1px solid var(--line);padding-top:14px}
.hc a.ext::after{content:" ↗";font-size:.75em;opacity:.6}
"""


def esc(s):
    return html.escape(str(s if s is not None else ''))


def build_inner(results, meta):
    n = lambda c: sum(1 for r in results if r['color'] == c)
    order = {'red': 0, 'orange': 1, 'yellow': 2, 'green': 3}
    P = [f"<style>{CSS}</style>", '<main class="hc">']
    P.append('<h1>🛒 Análisis de tu carro de Mercadona</h1>')
    sub = []
    if meta.get('postalCode'):
        sub.append(f"Entrega en {esc(meta['postalCode'])}")
    if meta.get('warehouse'):
        sub.append(f"almacén {esc(meta['warehouse'])}")
    sub.append(f"{len(results)} productos")
    P.append(f'<div class="sub">{" · ".join(sub)}</div>')

    P.append('<div class="summary">')
    for c, lab in [('green', 'sanos'), ('yellow', 'aceptables'), ('orange', 'mejor evitar'), ('red', 'a evitar')]:
        P.append(f'<div class="stat"><span class="dot {c}"></span><span class="n">{n(c)}</span> {lab}</div>')
    P.append('</div>')

    for r in sorted(results, key=lambda x: order.get(x['color'], 4)):
        P.append(f'<article class="card {r["color"]}">')
        price = f'{esc(r["price"])} €' if r.get('price') else ''
        name = esc(r['name'])
        name_html = f'<a class="cname ext" href="{esc(r["url"])}" target="_blank" rel="noopener">{name}</a>' if r.get('url') else f'<span class="cname">{name}</span>'
        P.append('<div class="chead"><div>' + name_html +
                 f'<div><span class="verdict {r["color"]}">{r["icon"]} {esc(r["verdict"])}</span></div></div>' +
                 (f'<div class="price">{price}</div>' if price else '') + '</div>')

        badges = [b for b in [f'Nutri-Score {r["nutriscore"]}' if r['nutriscore'] else None,
                              f'NOVA {r["nova"]}' if r['nova'] else None] if b]
        if badges:
            P.append('<div class="badges">' + ''.join(f'<span class="badge">{esc(b)}</span>' for b in badges) + '</div>')
        if r['ingredients']:
            P.append(f'<div class="ingredients"><strong>Ingredientes:</strong> {esc(r["ingredients"])}</div>')

        if r['additives']:
            P.append('<ul class="adds">')
            for a in r['additives']:
                cls = {'elevado': 'red', 'moderado': 'orange', 'limitado': 'yellow', 'ninguno': 'green'}.get(a['riesgo'], 'gray')
                src = f' <span class="src">[{esc(a["fuente"])}]</span>' if a['fuente'] else ''
                P.append(f'<li class="add"><span class="dot {cls}" style="align-self:center"></span>'
                         f'<span><span class="an">{esc(a["e"])} {esc(a["nombre"])}</span> '
                         f'<span class="ae">— {esc(a["efectos"])}</span>{src}</span></li>')
            P.append('</ul>')
        else:
            P.append('<div class="none">✅ Sin aditivos</div>')

        P.append(f'<div class="reason">{esc(r["reason"])}</div>')

        if r['alternatives']:
            P.append('<div class="alts"><span class="lbl">🔄 Alternativas más limpias</span>')
            for alt in r['alternatives']:
                pr = f' · <span class="price">{esc(alt["price"])} €</span>' if alt.get('price') else ''
                link = (f'<a class="ext" href="{esc(alt["url"])}" target="_blank" rel="noopener">{esc(alt["name"])}</a>'
                        if alt.get('url') else f'<span>{esc(alt["name"])}</span>')
                why = f'<span class="why">{esc(alt["reason"])}</span>' if alt.get('reason') else ''
                P.append(f'<div class="alt"><span>{link}{pr}</span>{why}</div>')
            P.append('</div>')
        P.append('</article>')

    P.append('<div class="foot">Informativo, no es consejo médico. El nivel de evidencia varía por aditivo; '
             'se cita el organismo o estudio de referencia (EFSA, ANSES, IARC, Yuka). '
             'Clasificación estricta: emulgentes y espesantes procesados marcados como riesgo elevado.</div>')
    P.append('</main>')
    return '\n'.join(P)


def full_html(results, meta):
    return ('<!doctype html><html lang="es"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>Análisis del carro de Mercadona</title></head>'
            f'<body style="margin:0">{build_inner(results, meta)}</body></html>')


def main():
    if len(sys.argv) < 2:
        print("uso: analyze.py cart.json [--html f.html] [--artifact f.html] [--json f.json]", file=sys.stderr)
        sys.exit(1)
    data = json.load(open(sys.argv[1], encoding='utf-8'))
    items = data.get('items', data if isinstance(data, list) else [])
    results = [analyze_item(it) for it in items]
    meta = {k: data.get(k) for k in ('warehouse', 'postalCode')}

    def arg(flag):
        return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else None

    if arg('--json'):
        json.dump({'meta': meta, 'results': results}, open(arg('--json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
    if arg('--html'):
        open(arg('--html'), 'w', encoding='utf-8').write(full_html(results, meta))
        print(f"HTML escrito en {arg('--html')}")
    if arg('--artifact'):
        open(arg('--artifact'), 'w', encoding='utf-8').write(build_inner(results, meta))
        print(f"Fragmento Artifact escrito en {arg('--artifact')}")
    if not (arg('--html') or arg('--artifact')):
        print(markdown(results, meta))


if __name__ == '__main__':
    main()
