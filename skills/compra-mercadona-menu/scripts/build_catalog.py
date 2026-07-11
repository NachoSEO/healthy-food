#!/usr/bin/env python3
"""
Construye un índice del catálogo de Mercadona (categorías de alimentación) para un almacén.
Uso: python3 build_catalog.py <wh> [catalog.json]   (wh por defecto: bcn1)
Guarda [{id, name, cat, subcat, price, ref, size}] navegando /api/categories/{id}/.
"""
import sys, json, urllib.request

WH = sys.argv[1] if len(sys.argv) > 1 else 'bcn1'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'catalog.json'
UA = {'User-Agent': 'Mozilla/5.0'}

# Categorías de alimentación (sin cosmética/hogar). Añade/quita según necesites.
CATS = {
 112: 'Aceite, vinagre y sal', 115: 'Especias', 116: 'Mayonesa, ketchup y mostaza', 117: 'Otras salsas',
 118: 'Arroz', 121: 'Legumbres', 120: 'Pasta y fideos',
 38: 'Aves y pollo', 40: 'Vacuno', 44: 'Hamburguesas y picadas', 37: 'Cerdo', 42: 'Conejo y cordero',
 48: 'Aves y jamón cocido', 54: 'Queso curado', 56: 'Queso lonchas', 53: 'Queso untable/fresco', 50: 'Jamón serrano',
 122: 'Atún y conservas pescado', 123: 'Berberechos y mejillones', 127: 'Conservas verdura',
 130: 'Gazpacho y cremas', 129: 'Sopa y caldo', 126: 'Tomate',
 28: 'Lechuga y ensalada', 29: 'Verdura',
 77: 'Huevos', 72: 'Leche y bebidas vegetales', 75: 'Mantequilla',
 59: 'Pan de horno', 60: 'Pan de molde', 62: 'Pan tostado y rallado',
 31: 'Pescado fresco', 32: 'Marisco', 34: 'Pescado congelado', 36: 'Salazones y ahumados',
 104: 'Yogures naturales', 105: 'Bifidus', 109: 'Yogures griegos',
 133: 'Frutos secos', 78: 'Cereales', 135: 'Aceitunas y encurtidos', 86: 'Cacao', 90: 'Mermelada y miel',
 145: 'Congelado fruta/verdura', 149: 'Pescado congelado 2', 150: 'Marisco congelado',
 142: 'Platos preparados fríos', 897: 'Listo para comer',
}


def get(url):
    for _ in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
                return json.load(r)
        except Exception:
            pass
    return None


def main():
    catalog = []
    for cid, cname in CATS.items():
        d = get(f'https://tienda.mercadona.es/api/categories/{cid}/?lang=es&wh={WH}')
        if not d:
            print('FALLO', cid, cname, file=sys.stderr)
            continue
        for sub in d.get('categories', []):
            for p in sub.get('products', []):
                pi = p.get('price_instructions') or {}
                catalog.append({'id': p.get('id'), 'name': p.get('display_name'),
                                'cat': cname, 'subcat': sub.get('name'),
                                'price': pi.get('unit_price'), 'ref': pi.get('reference_price'),
                                'size': pi.get('unit_size')})
    json.dump(catalog, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'{len(catalog)} productos indexados en {OUT} (wh={WH})')


if __name__ == '__main__':
    main()
