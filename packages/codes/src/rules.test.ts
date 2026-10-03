import { describe, it, expect } from 'vitest';
import { evaluate, lintDefinition, type Definition, type Part } from './rules';
import { pcDefinition, cafeDefinition } from '../../../db/configurators';

const p = (id: number, category: string, attrs: Record<string, unknown> = {}, qty = 1): Part => ({ id, category, attrs, qty, name: `${category}-${id}` });
const rules = (def: Definition, parts: Part[]) => evaluate(def, parts).map(v => v.rule);

describe('motor de configuradores', () => {
  const pc = [p(1, 'cpu', { socket: 'AM5', tdp_w: 65 }), p(2, 'motherboard', { socket: 'AM5', ram_types: ['DDR5'], form_factor: 'ATX' }), p(3, 'ram', { ram_type: 'DDR5' }),
    p(4, 'storage'), p(5, 'psu', { watts: 650 }), p(6, 'case', { form_factors: ['ATX', 'mATX'] })];
  it('PC válida no produce avisos; cada regla se dispara con su id', () => {
    expect(evaluate(pcDefinition, pc)).toEqual([]);
    expect(rules(pcDefinition, pc.map(x => x.id === 1 ? p(1, 'cpu', { socket: 'LGA1700', tdp_w: 65 }) : x))).toEqual(['socket']);
    expect(rules(pcDefinition, pc.map(x => x.id === 3 ? p(3, 'ram', { ram_type: 'DDR4' }) : x))).toEqual(['memoria']);
    expect(rules(pcDefinition, pc.map(x => x.id === 6 ? p(6, 'case', { form_factors: ['mATX'] }) : x))).toEqual(['formato']);
    expect(rules(pcDefinition, [...pc, p(7, 'gpu', { tdp_w: 450 })])).toEqual(['potencia']); // (65+450)×1.3 > 650
    expect(rules(pcDefinition, [...pc, p(7, 'gpu', { tdp_w: 200 }, 2)])).toEqual([]);         // cantidad cuenta: (65+400)×1.3 = 604.5
    expect(rules(pcDefinition, pc.slice(1))).toEqual(['grupo_obligatorio']);
  });
  it('café: prohibir, exigir, pertenencia y cantidades', () => {
    const latte = p(1, 'bebida', { lleva_leche: true, tamanos: ['chico', 'mediano', 'grande'] }), espresso = p(2, 'bebida', { lleva_leche: false, tamanos: ['chico'] });
    const chico = p(3, 'tamano', { clave: 'chico' }), grande = p(4, 'tamano', { clave: 'grande' }), avena = p(5, 'leche');
    expect(evaluate(cafeDefinition, [latte, grande, avena])).toEqual([]);
    expect(evaluate(cafeDefinition, [espresso, chico])).toEqual([]);
    expect(rules(cafeDefinition, [espresso, chico, avena])).toEqual(['sin_leche']);
    expect(rules(cafeDefinition, [latte, chico])).toEqual(['con_leche']);
    expect(rules(cafeDefinition, [espresso, grande])).toEqual(['tamano_disponible']);
    expect(rules(cafeDefinition, [latte, chico, avena, p(6, 'endulzante', {}, 4)])).toEqual(['cantidad_maxima']);
    expect(rules(cafeDefinition, [latte, chico, avena, p(7, 'cpu')])).toEqual(['categoria_no_permitida']);
    expect(evaluate(cafeDefinition, [espresso, chico, avena])[0].message).toBe('Esta bebida no lleva leche');
  });
  it('lintDefinition detecta definiciones incoherentes', () => {
    expect(lintDefinition(pcDefinition)).toEqual([]); expect(lintDefinition(cafeDefinition)).toEqual([]);
    const bad: Definition = { itemLabel: 'x', groups: [{ category: 'a', label: 'A', min: 2, max: 1 }, { category: 'a', label: 'A2', min: 0, max: 1 }],
      rules: [{ id: 'r', type: 'equals', a: { group: 'a', attr: 'k' }, b: { group: 'zz', attr: 'k' } }, { id: 'r', type: 'forbid', when: { group: 'a', attr: 'k', equals: 1 }, group: 'a', message: 'm' }] };
    const errs = lintDefinition(bad).join(' | ');
    expect(errs).toContain('repetidas'); expect(errs).toContain('min mayor que max'); expect(errs).toContain('"zz" no existe'); expect(errs).toContain('Regla duplicada');
  });
});
