// Definiciones de ejemplo de la semilla. Son DATOS: la consola permite editarlas o crear otras sin desplegar.
import type { Definition } from '../packages/codes/src/rules';

export const pcDefinition: Definition = {
  itemLabel: 'Ensamble',
  groups: [
    { category: 'cpu', label: 'Procesador', min: 1, max: 1 },
    { category: 'motherboard', label: 'Tarjeta madre', min: 1, max: 1 },
    { category: 'ram', label: 'Memoria RAM', min: 1, max: 2, maxQty: 4 },
    { category: 'storage', label: 'Almacenamiento', min: 1, max: 4, maxQty: 6 },
    { category: 'psu', label: 'Fuente de poder', min: 1, max: 1 },
    { category: 'case', label: 'Gabinete', min: 1, max: 1 },
    { category: 'gpu', label: 'Tarjeta gráfica', min: 0, max: 1, maxQty: 2, hint: 'Opcional' },
  ],
  rules: [
    { id: 'socket', type: 'equals', a: { group: 'cpu', attr: 'socket' }, b: { group: 'motherboard', attr: 'socket' } },
    { id: 'memoria', type: 'in', a: { group: 'ram', attr: 'ram_type' }, b: { group: 'motherboard', attr: 'ram_types' } },
    { id: 'formato', type: 'in', a: { group: 'motherboard', attr: 'form_factor' }, b: { group: 'case', attr: 'form_factors' } },
    { id: 'potencia', type: 'sum_lte', attr: 'tdp_w', factor: 1.3, limit: { group: 'psu', attr: 'watts' }, unit: 'W' },
  ],
};

export const cafeDefinition: Definition = {
  itemLabel: 'Bebida',
  groups: [
    { category: 'bebida', label: 'Bebida', min: 1, max: 1 },
    { category: 'tamano', label: 'Tamaño', min: 1, max: 1 },
    { category: 'leche', label: 'Tipo de leche', min: 0, max: 1, hint: 'Según la bebida' },
    { category: 'endulzante', label: 'Endulzante', min: 0, max: 1, maxQty: 3, hint: 'Opcional · hasta 3 sobres' },
    { category: 'extra', label: 'Extras', min: 0, max: 4, maxQty: 2, hint: 'Opcional' },
  ],
  rules: [
    { id: 'tamano_disponible', type: 'in', a: { group: 'tamano', attr: 'clave' }, b: { group: 'bebida', attr: 'tamanos' }, message: 'Ese tamaño no está disponible para la bebida elegida' },
    { id: 'sin_leche', type: 'forbid', when: { group: 'bebida', attr: 'lleva_leche', equals: false }, group: 'leche', message: 'Esta bebida no lleva leche' },
    { id: 'con_leche', type: 'require', when: { group: 'bebida', attr: 'lleva_leche', equals: true }, group: 'leche', message: 'Elige el tipo de leche' },
  ],
};

type P = [sku: string, name: string, cat: string, cents: number, stock: number, attrs: Record<string, unknown>];
const all = ['chico', 'mediano', 'grande'];
/** Catálogo de ejemplo de la cafetería (tenant 0003). Precios de EJEMPLO en centavos; las opciones sin costo valen 0. */
export const cafeCatalog: P[] = [
  ['BEB-ESPRESSO', 'Espresso', 'bebida', 3500, 500, { lleva_leche: false, tamanos: ['chico'] }],
  ['BEB-AMERICANO', 'Americano', 'bebida', 4000, 500, { lleva_leche: false, tamanos: all }],
  ['BEB-LATTE', 'Latte', 'bebida', 5500, 500, { lleva_leche: true, tamanos: all }],
  ['BEB-CAPUCHINO', 'Capuchino', 'bebida', 5500, 500, { lleva_leche: true, tamanos: all }],
  ['BEB-FLATWHITE', 'Flat white', 'bebida', 5800, 500, { lleva_leche: true, tamanos: ['chico', 'mediano'] }],
  ['TAM-CHICO', 'Chico (8 oz)', 'tamano', 0, 9999, { clave: 'chico' }],
  ['TAM-MEDIANO', 'Mediano (12 oz)', 'tamano', 800, 9999, { clave: 'mediano' }],
  ['TAM-GRANDE', 'Grande (16 oz)', 'tamano', 1500, 9999, { clave: 'grande' }],
  ['LEC-ENTERA', 'Leche entera', 'leche', 0, 500, {}],
  ['LEC-DESLACTOSADA', 'Leche deslactosada', 'leche', 0, 500, {}],
  ['LEC-AVENA', 'Bebida de avena', 'leche', 1200, 300, {}],
  ['LEC-ALMENDRA', 'Bebida de almendra', 'leche', 1200, 300, {}],
  ['LEC-SOYA', 'Bebida de soya', 'leche', 1000, 300, {}],
  ['END-AZUCAR', 'Azúcar', 'endulzante', 0, 9999, {}],
  ['END-STEVIA', 'Stevia', 'endulzante', 0, 9999, {}],
  ['END-MASCABADO', 'Azúcar mascabado', 'endulzante', 0, 9999, {}],
  ['EXT-SHOT', 'Shot extra de espresso', 'extra', 1500, 500, {}],
  ['EXT-VAINILLA', 'Jarabe de vainilla', 'extra', 1000, 300, {}],
  ['EXT-CARAMELO', 'Jarabe de caramelo', 'extra', 1000, 300, {}],
  ['EXT-CREMA', 'Crema batida', 'extra', 800, 300, {}],
  ['EXT-CANELA', 'Canela', 'extra', 0, 9999, {}],
];
