#!/usr/bin/env python3
"""
Genera un informe HTML de la compra (agrupado por secciones, con semáforo de salud,
cantidades, precios, enlaces a producto y cambios por salud).

Uso: python3 report.py cart_menu.json analisis.json compra.html
  - cart_menu.json: {items:[{id,label,name,qty,price,url,fresh,swapped_from}]}
  - analisis.json:  salida de analyze.py --json  ({results:[{id,color,icon,additives,nova,nutriscore}]})
El fichero de salida es HTML autónomo (abrible en navegador o publicable como Artifact).
"""
import sys, json, html
from collections import Counter, defaultdict

if len(sys.argv) < 4:
    print("uso: report.py cart_menu.json analisis.json salida.html", file=sys.stderr); sys.exit(1)

cm = {str(it['id']): it for it in json.load(open(sys.argv[1], encoding='utf-8'))['items']}
res = json.load(open(sys.argv[2], encoding='utf-8'))['results']
byid = {str(r['id']): r for r in res}
OUT = sys.argv[3]

# Grupos por secciones de supermercado (heurística por etiqueta). Ajusta a tu menú.
GROUPS = [
 ("🫘 Legumbre", ["Lenteja", "Garbanzo", "Alubia"]),
 ("🌾 Cereales, pasta y pan", ["Macarron", "Spaghetti", "Arroz", "Quinoa", "Fideo", "Copos", "Pan", "Avena"]),
 ("🐟 Pescado y marisco", ["Merluza", "Salmón", "Salmon", "Dorada", "Langostino", "Atún", "Atun", "Bonito", "Gamba"]),
 ("🍗 Carne y aves", ["pollo", "pavo", "ternera", "picada", "Pechuga"]),
 ("🥚 Huevos y lácteos", ["Huevo", "Leche", "Yogur", "Queso"]),
 ("🥬 Verdura fresca", ["Ajo", "Tomate ensalada", "Calabacín", "Calabaza", "Pimiento", "Zanahoria", "Pepino", "Puerro", "Patata", "Champiñón", "Ensalada", "Lechuga"]),
 ("❄️ Congelados y conserva verdura", ["Espinaca", "Guisante", "Maíz", "Maiz", "Tomate triturado"]),
 ("🫒 Despensa y otros", ["AOVE", "Aceite", "Vinagre", "Sal", "Aceituna", "Nuez", "Nueces", "Cacao", "Hummus", "Gazpacho", "Salmorejo", "Caldo"]),
]
def grp(label):
    for g, keys in GROUPS:
        if any(k.lower() in label.lower() for k in keys):
            return g
    return "🫒 Despensa y otros"

DOT = {'red': '#cf4436', 'orange': '#dd6f2c', 'yellow': '#c99512', 'green': '#2f9e63'}
def esc(s): return html.escape(str(s if s is not None else ''))

items = []
total = 0.0
for it in cm.values():
    r = byid.get(str(it['id']), {})
    price = float(it['price']) if it.get('price') else 0
    total += price * it.get('qty', 1)
    items.append({**it, 'color': r.get('color', 'green'), 'icon': r.get('icon', '🟢'),
                  'additives': r.get('additives', []), 'group': grp(it.get('label', it.get('name', '')))})
cc = Counter(i['color'] for i in items)
groups = defaultdict(list)
for i in items:
    groups[i['group']].append(i)

CSS = """<style>
:root{--bg:#f5f8f3;--panel:#fff;--ink:#1a241d;--muted:#5c6b5f;--line:#e3ebdf;--accent:#2f9e63;--gb:#e8f5ec;--yb:#fbf3dc;}
@media(prefers-color-scheme:dark){:root{--bg:#10140e;--panel:#1a1f17;--ink:#e9eee6;--muted:#9aa896;--line:#2b3327;--accent:#4cc584;--gb:#16281d;--yb:#2a2413;}}
:root[data-theme="dark"]{--bg:#10140e;--panel:#1a1f17;--ink:#e9eee6;--muted:#9aa896;--line:#2b3327;--accent:#4cc584;--gb:#16281d;--yb:#2a2413;}
:root[data-theme="light"]{--bg:#f5f8f3;--panel:#fff;--ink:#1a241d;--muted:#5c6b5f;--line:#e3ebdf;--accent:#2f9e63;--gb:#e8f5ec;--yb:#fbf3dc;}
*{box-sizing:border-box}
.hc{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);line-height:1.5;padding:30px 18px 60px;max-width:840px;margin:0 auto;-webkit-font-smoothing:antialiased}
.hc h1{font-size:1.6rem;font-weight:750;letter-spacing:-.02em;margin:0 0 3px}
.hc .sub{color:var(--muted);font-size:.9rem;margin-bottom:20px}
.hc .summary{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.hc .stat{display:flex;align-items:center;gap:7px;padding:8px 13px;border:1px solid var(--line);border-radius:11px;background:var(--panel);font-size:.85rem;font-weight:600}
.hc .stat .n{font-size:1.05rem;font-variant-numeric:tabular-nums}
.hc .dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block}
.hc .tot{margin-left:auto;font-size:1rem;font-weight:750}
.hc .note{background:var(--yb);border:1px solid var(--line);border-radius:11px;padding:12px 15px;font-size:.85rem;margin:14px 0}
.hc h2{font-size:1.05rem;font-weight:700;margin:26px 0 8px;padding-bottom:6px;border-bottom:2px solid var(--line)}
.hc .row{display:flex;align-items:baseline;gap:10px;padding:9px 4px;border-bottom:1px solid var(--line)}
.hc .row:last-child{border-bottom:none}
.hc .q{font-variant-numeric:tabular-nums;font-weight:700;color:var(--muted);min-width:26px;font-size:.85rem}
.hc .nm{flex:1;min-width:0}
.hc .nm a{color:var(--ink);text-decoration:none;font-weight:550}
.hc .nm a:hover{color:var(--accent);text-decoration:underline}
.hc .ad{font-size:.76rem;color:var(--muted);margin-top:2px}
.hc .pr{font-variant-numeric:tabular-nums;font-weight:650;white-space:nowrap;font-size:.9rem}
.hc .sw{background:var(--gb);border-radius:8px;padding:2px 7px;font-size:.72rem;color:var(--accent);font-weight:600;display:inline-block;margin-top:3px}
.hc .foot{margin-top:26px;font-size:.76rem;color:var(--muted);border-top:1px solid var(--line);padding-top:13px}
.hc a.ext::after{content:" ↗";font-size:.75em;opacity:.55}
</style>"""

P = [CSS, '<main class="hc">', '<h1>🛒 Compra de Mercadona</h1>']
P.append(f'<div class="sub">{len(items)} productos · ≈ {total:.2f} €</div>')
P.append('<div class="summary">')
for c, l in [('green', 'sanos'), ('yellow', 'aceptables'), ('orange', 'mejor evitar'), ('red', 'a evitar')]:
    P.append(f'<div class="stat"><span class="dot" style="background:{DOT[c]}"></span><span class="n">{cc.get(c,0)}</span> {l}</div>')
P.append(f'<div class="stat tot">≈ {total:.2f} €</div></div>')

sw = [i for i in items if i.get('swapped_from')]
if sw:
    P.append('<div class="note">🔄 <b>Cambios automáticos por salud:</b><br>')
    for i in sw:
        P.append(f"• {esc(i['swapped_from']['name'])} → <b>{esc(i['name'])}</b><br>")
    P.append('</div>')

for g, _ in GROUPS:
    its = groups.get(g, [])
    if not its:
        continue
    gsum = sum((float(i['price']) if i.get('price') else 0) * i.get('qty', 1) for i in its)
    P.append(f'<h2>{esc(g)} <span style="float:right;font-weight:600;color:var(--muted);font-size:.85rem">{gsum:.2f} €</span></h2>')
    for i in sorted(its, key=lambda x: {'red': 0, 'orange': 1, 'yellow': 2, 'green': 3}.get(x['color'], 3)):
        risky = [a for a in i['additives'] if a['riesgo'] in ('elevado', 'moderado', 'limitado')]
        adline = ('<div class="ad">' + '; '.join(f"{esc(a['e'])} {esc(a['nombre'])}" for a in risky[:3]) + '</div>') if risky else ''
        nm = (f'<a class="ext" href="{esc(i["url"])}" target="_blank" rel="noopener">{esc(i["name"])}</a>'
              if i.get('url') else esc(i['name']))
        swb = '<div class="sw">✅ cambiado por salud</div>' if i.get('swapped_from') else ''
        pr = float(i['price']) * i.get('qty', 1) if i.get('price') else 0
        P.append(f'<div class="row"><span class="q">{i.get("qty",1)}×</span>'
                 f'<span class="dot" style="background:{DOT[i["color"]]};align-self:center"></span>'
                 f'<span class="nm">{nm}{adline}{swb}</span>'
                 f'<span class="pr">{pr:.2f} €</span></div>')

P.append('<div class="foot">Precios estimados (frescos por peso variable). Análisis con Open Food Facts + '
         'base de aditivos. Informativo, no es consejo médico.</div></main>')
open(OUT, 'w', encoding='utf-8').write('\n'.join(P))
print(f"HTML en {OUT} · ≈{total:.2f}€ · {dict(cc)}")
