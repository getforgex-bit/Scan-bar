// Motor de configuradores (sección 5). Las reglas son DATOS por tenant; este evaluador es el mismo
// en cliente (respuesta inmediata) y en servidor (autoridad). Sin dependencias.

export type Part = { id: number; category: string; attrs: Record<string, any>; qty?: number; name?: string };

/** Un grupo es una categoría de producto de la que el cliente elige entre `min` y `max` opciones. */
export type Group = { category: string; label: string; min: number; max: number; maxQty?: number; hint?: string };
export type Ref = { group: string; attr: string };
export type When = { group: string; attr: string; equals: unknown };

export type Rule =
  /** a.attr debe ser igual a b.attr (p. ej. socket del CPU = socket de la placa). */
  | { id: string; type: 'equals'; a: Ref; b: Ref; message?: string }
  /** a.attr debe estar en la lista b.attr (p. ej. tamaño ∈ tamaños de la bebida). */
  | { id: string; type: 'in'; a: Ref; b: Ref; message?: string }
  /** Σ attr × cantidad × factor ≤ limit.attr (p. ej. consumo ≤ potencia de la fuente). */
  | { id: string; type: 'sum_lte'; attr: string; factor?: number; limit: Ref; unit?: string; message?: string }
  /** Si alguna opción elegida cumple `when`, el grupo `group` debe quedar vacío. */
  | { id: string; type: 'forbid'; when: When; group: string; message: string }
  /** Si alguna opción elegida cumple `when`, el grupo `group` debe tener al menos una opción. */
  | { id: string; type: 'require'; when: When; group: string; message: string };

export type Definition = { itemLabel: string; groups: Group[]; rules: Rule[] };
export type Violation = { rule: string; message: string; group?: string };

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

export function evaluate(def: Definition, parts: Part[]): Violation[] {
  const out: Violation[] = [];
  const by = (c: string) => parts.filter(p => p.category === c);
  const label = (c: string) => def.groups.find(g => g.category === c)?.label ?? c;
  const known = new Set(def.groups.map(g => g.category));

  for (const p of parts) if (!known.has(p.category))
    out.push({ rule: 'categoria_no_permitida', message: `${p.name ?? 'Un artículo'} no pertenece a este configurador`, group: p.category });

  for (const g of def.groups) {
    const sel = by(g.category);
    if (sel.length < g.min) out.push({ rule: 'grupo_obligatorio', message: g.min === 1 ? `Falta elegir: ${g.label}` : `Elige al menos ${g.min} en ${g.label}`, group: g.category });
    if (sel.length > g.max) out.push({ rule: 'grupo_maximo', message: `${g.label}: máximo ${g.max} ${g.max === 1 ? 'opción' : 'opciones'}`, group: g.category });
    for (const p of sel) if ((p.qty ?? 1) > (g.maxQty ?? 1))
      out.push({ rule: 'cantidad_maxima', message: `${p.name ?? g.label}: máximo ${g.maxQty ?? 1} por pedido`, group: g.category });
  }

  for (const r of def.rules) {
    if (r.type === 'equals' || r.type === 'in') {
      const as = by(r.a.group), bs = by(r.b.group);
      if (!as.length || !bs.length) continue; // se evalúa cuando ambos grupos tienen selección
      for (const a of as) for (const b of bs) {
        const av = a.attrs[r.a.attr], bv = b.attrs[r.b.attr];
        const ok = r.type === 'equals' ? av === bv : list(bv).includes(av);
        if (!ok) out.push({ rule: r.id, group: r.a.group, message: r.message ?? (r.type === 'equals'
          ? `${label(r.a.group)} (${av}) no coincide con ${label(r.b.group)} (${bv})`
          : `${label(r.a.group)} (${av}) no es compatible con ${label(r.b.group)} (${list(bv).join('/')})`) });
      }
    } else if (r.type === 'sum_lte') {
      const lim = by(r.limit.group)[0];
      if (!lim) continue;
      const need = parts.reduce((s, p) => s + (Number(p.attrs[r.attr]) || 0) * (p.qty ?? 1), 0) * (r.factor ?? 1);
      const have = Number(lim.attrs[r.limit.attr]) || 0;
      if (have < need) out.push({ rule: r.id, group: r.limit.group, message: r.message ?? `${label(r.limit.group)} de ${have} ${r.unit ?? ''} insuficiente: se requieren ${Math.ceil(need)} ${r.unit ?? ''}`.trim() });
    } else {
      const active = by(r.when.group).some(p => p.attrs[r.when.attr] === r.when.equals);
      if (!active) continue;
      const n = by(r.group).length;
      if (r.type === 'forbid' && n > 0) out.push({ rule: r.id, message: r.message, group: r.group });
      if (r.type === 'require' && n === 0) out.push({ rule: r.id, message: r.message, group: r.group });
    }
  }
  // Una regla 'require' y el mínimo del grupo pueden reportar lo mismo: se deja un aviso por (regla, mensaje).
  const seen = new Set<string>();
  return out.filter(v => { const k = v.rule + '|' + v.message; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** Comprueba que la definición es coherente (categorías únicas, referencias existentes). Devuelve errores legibles. */
export function lintDefinition(def: Definition): string[] {
  const errs: string[] = [];
  const cats = def.groups.map(g => g.category);
  if (new Set(cats).size !== cats.length) errs.push('Hay categorías de grupo repetidas');
  for (const g of def.groups) if (g.min > g.max) errs.push(`Grupo ${g.category}: min mayor que max`);
  const has = (c: string) => cats.includes(c);
  const ids = new Set<string>();
  for (const r of def.rules) {
    if (ids.has(r.id)) errs.push(`Regla duplicada: ${r.id}`); ids.add(r.id);
    const refs = r.type === 'equals' || r.type === 'in' ? [r.a.group, r.b.group] : r.type === 'sum_lte' ? [r.limit.group] : [r.when.group, r.group];
    for (const c of refs) if (!has(c)) errs.push(`Regla ${r.id}: el grupo "${c}" no existe`);
  }
  return errs;
}
