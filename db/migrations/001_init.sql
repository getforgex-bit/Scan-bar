-- Esquema de la sección 2. Dinero en centavos; RLS por tenant_id.
CREATE FUNCTION gtin_check_ok(g TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT g ~ '^[0-9]{13}$'
     AND (10 - (SELECT sum(substr(g, i, 1)::int * CASE WHEN i % 2 = 1 THEN 1 ELSE 3 END)
                FROM generate_series(1, 12) AS i) % 10) % 10 = substr(g, 13, 1)::int
$$;

CREATE TABLE tenants (
  id SMALLSERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  gs1_prefix TEXT NOT NULL DEFAULT '750',
  company_prefix TEXT NOT NULL UNIQUE CHECK (company_prefix ~ '^[0-9]{4}$'),
  product_url_tpl TEXT NOT NULL,
  build_url_tpl TEXT,
  allowed_domains TEXT[] NOT NULL DEFAULT '{}',
  link_status TEXT NOT NULL DEFAULT 'unknown',
  rules JSONB NOT NULL DEFAULT '{"powerFactor":1.3}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  user_id BIGINT NOT NULL REFERENCES users(id),
  tenant_id SMALLINT NOT NULL REFERENCES tenants(id),
  role TEXT NOT NULL CHECK (role IN ('superadmin','operador_pos')),
  PRIMARY KEY (user_id, tenant_id)
);
CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  tenant_id SMALLINT NOT NULL REFERENCES tenants(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL DEFAULT 0,
  attrs JSONB NOT NULL DEFAULT '{}',
  active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (tenant_id, sku)
);
CREATE TABLE code_counters (
  tenant_id SMALLINT PRIMARY KEY REFERENCES tenants(id),
  next_item INTEGER NOT NULL DEFAULT 1 CHECK (next_item <= 100000)
);
CREATE TABLE builds (
  id BIGSERIAL PRIMARY KEY,
  tenant_id SMALLINT NOT NULL REFERENCES tenants(id),
  bom_hash CHAR(64) NOT NULL,
  total_cents INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bom_hash)
);
CREATE TABLE build_items (
  build_id BIGINT NOT NULL REFERENCES builds(id) ON DELETE RESTRICT,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  tenant_id SMALLINT NOT NULL REFERENCES tenants(id),
  qty SMALLINT NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL,
  PRIMARY KEY (build_id, product_id)
);
CREATE TABLE codes (
  gtin CHAR(13) PRIMARY KEY CHECK (gtin ~ '^[0-9]{13}$'),
  tenant_id SMALLINT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK (kind IN ('product','build')),
  product_id BIGINT REFERENCES products(id),
  build_id BIGINT REFERENCES builds(id),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  CHECK ((kind='product' AND product_id IS NOT NULL AND build_id IS NULL)
      OR (kind='build' AND build_id IS NOT NULL AND product_id IS NULL)),
  CHECK (gtin_check_ok(gtin))
);
CREATE TABLE sales (
  id BIGSERIAL PRIMARY KEY,
  tenant_id SMALLINT NOT NULL REFERENCES tenants(id),
  idempotency_key TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'efectivo',
  user_id BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE TABLE sale_items (
  id BIGSERIAL PRIMARY KEY,
  sale_id BIGINT NOT NULL REFERENCES sales(id),
  tenant_id SMALLINT NOT NULL REFERENCES tenants(id),
  gtin CHAR(13) NOT NULL REFERENCES codes(gtin),
  name TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL
);
CREATE TABLE scan_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id SMALLINT REFERENCES tenants(id),
  mode TEXT NOT NULL, engine TEXT NOT NULL, device TEXT,
  decode_ms REAL, total_ms REAL, result TEXT NOT NULL,
  gtin TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id SMALLINT, user_id BIGINT, action TEXT NOT NULL,
  before JSONB, after JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE http_log (
  id BIGSERIAL PRIMARY KEY, request_id TEXT, method TEXT, route TEXT,
  tenant_id SMALLINT, status INTEGER, duration_ms REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION allocate_item(t SMALLINT) RETURNS INTEGER LANGUAGE sql AS $$
  UPDATE code_counters SET next_item = next_item + 1 WHERE tenant_id = t RETURNING next_item - 1
$$;

-- Roles de base
DO $r$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_rw') THEN CREATE ROLE app_rw NOLOGIN; END IF; -- la contraseña la fija scripts/migrate.ts desde variables de entorno
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='admin_ro') THEN CREATE ROLE admin_ro NOLOGIN BYPASSRLS; END IF;
END $r$;
GRANT USAGE ON SCHEMA public TO app_rw, admin_ro;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_rw;
REVOKE UPDATE ON build_items, codes FROM app_rw;
GRANT UPDATE (retired_at) ON codes TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO admin_ro;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_rw, admin_ro;

-- RLS en toda tabla con tenant_id
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['products','code_counters','builds','build_items','codes','sales','sale_items','scan_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::smallint) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::smallint)$p$, t);
  END LOOP;
END $$;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = nullif(current_setting('app.tenant_id', true),'')::smallint);

-- Resolver público: única excepción (SECURITY DEFINER, solo campos necesarios)
CREATE FUNCTION resolve_gtin(g TEXT) RETURNS TABLE (
  tenant_id SMALLINT, kind TEXT, sku TEXT, name TEXT, price_cents INTEGER, retired BOOLEAN,
  product_url_tpl TEXT, build_url_tpl TEXT, allowed_domains TEXT[], link_status TEXT, build_id BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.tenant_id, c.kind, p.sku,
         CASE WHEN c.kind='product' THEN p.name ELSE 'Ensamble ' || c.gtin END,
         CASE WHEN c.kind='product' THEN p.price_cents ELSE b.total_cents END,
         c.retired_at IS NOT NULL, t.product_url_tpl, t.build_url_tpl, t.allowed_domains, t.link_status, c.build_id
  FROM codes c JOIN tenants t ON t.id=c.tenant_id
  LEFT JOIN products p ON p.id=c.product_id LEFT JOIN builds b ON b.id=c.build_id
  WHERE c.gtin = g
$$;
CREATE FUNCTION resolve_build_bom(bid BIGINT) RETURNS TABLE (name TEXT, qty SMALLINT, unit_price_cents INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.name, bi.qty, bi.unit_price_cents FROM build_items bi JOIN products p ON p.id=bi.product_id WHERE bi.build_id=bid ORDER BY p.category
$$;
CREATE FUNCTION allowed_domains_all() RETURNS TEXT[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(array_agg(DISTINCT d), '{}') FROM tenants, unnest(allowed_domains) d
$$;
CREATE FUNCTION login_lookup(e TEXT) RETURNS TABLE (id BIGINT, password_hash TEXT, tenant_id SMALLINT, role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.password_hash, m.tenant_id, m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=e
$$;
REVOKE ALL ON FUNCTION resolve_gtin(TEXT), resolve_build_bom(BIGINT), allowed_domains_all(), login_lookup(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_gtin(TEXT), resolve_build_bom(BIGINT), allowed_domains_all(), login_lookup(TEXT) TO app_rw;

-- Acceso directo a users/memberships solo para el rol de mantenimiento (seed); la app usa login_lookup
REVOKE ALL ON users, memberships FROM app_rw;

-- Vistas para el visor (sin columnas sensibles)
CREATE VIEW v_products AS SELECT id, tenant_id, sku, name, category, price_cents, stock, active FROM products;
CREATE VIEW v_codes AS SELECT gtin, tenant_id, kind, product_id, build_id, issued_at, retired_at FROM codes;
CREATE VIEW v_builds AS SELECT id, tenant_id, total_cents, active, created_at FROM builds;
CREATE VIEW v_sales AS SELECT id, tenant_id, total_cents, tax_cents, payment_method, created_at FROM sales;
CREATE VIEW v_scan_events AS SELECT id, tenant_id, mode, engine, device, decode_ms, total_ms, result, created_at FROM scan_events;
GRANT SELECT ON v_products, v_codes, v_builds, v_sales, v_scan_events TO admin_ro;
