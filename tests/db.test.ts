import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { freshDb } from './helpers';
import { makeDb, withTenant, type Db } from '../apps/api/src/db';

let db: Db; let owner: pg.Pool;
beforeAll(async () => { const u = await freshDb(); db = makeDb(u); owner = new pg.Pool({ connectionString: u.ownerUrl }); });
afterAll(async () => { await db.close(); await owner.end(); });

describe('RLS', () => {
  it('(1) un tenant no lee ni escribe filas de otro', async () => {
    const t = (await owner.query('SELECT id FROM tenants ORDER BY id LIMIT 2')).rows;
    const [a, b] = [t[0].id, t[1].id];
    const seen = await withTenant(db, a, async tx => (await tx.query('SELECT DISTINCT tenant_id FROM products')).rows);
    expect(seen.map(r => r.tenant_id)).toEqual([a]);
    await expect(withTenant(db, a, tx => tx.query("INSERT INTO products (tenant_id,sku,name,category,price_cents) VALUES ($1,'X','x','x',1)", [b]))).rejects.toThrow(/row-level security/);
    const upd = await withTenant(db, a, tx => tx.query('UPDATE products SET stock=0 WHERE tenant_id=$1', [b]));
    expect(upd.rowCount).toBe(0);
  });
  it('(2) sin app.tenant_id la consulta no devuelve filas', async () => {
    const r = await db.app.query('SELECT * FROM products');
    expect(r.rowCount).toBe(0);
  });
  it('(3) gtin_check_ok', async () => {
    const f = async (g: string) => (await db.app.query('SELECT gtin_check_ok($1) AS ok', [g])).rows[0].ok;
    expect(await f('7500002000891')).toBe(true);
    expect(await f('7500002000894')).toBe(false);
    expect(await f('4006381333931')).toBe(true);
  });
  it('(4) 100 llamadas concurrentes a allocate_item devuelven 100 números distintos', async () => {
    const tid = (await owner.query('SELECT id FROM tenants WHERE slug=$1', ['tienda-0003'])).rows[0].id;
    const res = await Promise.all(Array.from({ length: 100 }, () => withTenant(db, tid, async tx => (await tx.query('SELECT allocate_item($1::smallint) AS n', [tid])).rows[0].n as number)));
    expect(new Set(res).size).toBe(100);
  });
  it('CHECK de codes rechaza GTIN inválido y admin_ro es solo lectura', async () => {
    await expect(owner.query("INSERT INTO codes (gtin,tenant_id,kind,product_id) VALUES ('7500002000894',1,'product',1)")).rejects.toThrow();
    await expect(db.admin.query('DELETE FROM v_products')).rejects.toThrow();
    expect((await db.admin.query('SELECT count(*)::int AS n FROM v_products')).rows[0].n).toBeGreaterThan(40); // BYPASSRLS
  });
});
