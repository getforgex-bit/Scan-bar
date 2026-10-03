-- Configuradores genéricos (reglas como datos por tenant), cuentas de cliente y configuraciones guardadas.

CREATE TABLE configurators (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   SMALLINT NOT NULL REFERENCES tenants(id),
  slug        TEXT NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition  JSONB NOT NULL,               -- { itemLabel, groups[], rules[] } validado en la API
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
ALTER TABLE builds ADD COLUMN configurator_id BIGINT REFERENCES configurators(id);

CREATE TABLE build_saves (
  user_id    BIGINT NOT NULL REFERENCES users(id),
  build_id   BIGINT NOT NULL REFERENCES builds(id),
  tenant_id  SMALLINT NOT NULL REFERENCES tenants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, build_id)
);

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['configurators','build_saves'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::smallint) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::smallint)$p$, t);
  END LOOP;
END $$;

GRANT SELECT ON configurators TO app_rw, admin_ro;
GRANT SELECT, INSERT, UPDATE ON configurators TO admin_rw;
GRANT SELECT, INSERT ON build_saves TO app_rw;
GRANT SELECT ON build_saves TO admin_ro, admin_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw, admin_rw;

-- ===== Acceso público (SECURITY DEFINER: solo los campos necesarios) =====
CREATE FUNCTION public_configurators() RETURNS TABLE (tenant_slug TEXT, tenant_name TEXT, slug TEXT, name TEXT, description TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.slug, t.name, c.slug, c.name, c.description
  FROM configurators c JOIN tenants t ON t.id = c.tenant_id WHERE c.active ORDER BY t.id, c.id
$$;
CREATE FUNCTION public_tenant(s TEXT) RETURNS TABLE (id SMALLINT, slug TEXT, name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, slug, name FROM tenants WHERE slug = s
$$;

-- ===== Cuentas =====
CREATE FUNCTION register_user(e TEXT, h TEXT) RETURNS BIGINT
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO users (email, password_hash) VALUES (e, h) ON CONFLICT (email) DO NOTHING RETURNING id
$$;
-- Usuarios sin membresía (clientes registrados) también pueden iniciar sesión: tenant_id y role salen NULL.
CREATE OR REPLACE FUNCTION login_lookup(e TEXT) RETURNS TABLE (id BIGINT, password_hash TEXT, tenant_id SMALLINT, role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.password_hash, m.tenant_id, m.role FROM users u LEFT JOIN memberships m ON m.user_id = u.id WHERE u.email = e
  ORDER BY m.tenant_id NULLS LAST
$$;
CREATE FUNCTION user_auth(uid BIGINT) RETURNS TABLE (email TEXT, password_hash TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT email, password_hash FROM users WHERE id = uid
$$;
CREATE FUNCTION user_builds(uid BIGINT) RETURNS TABLE (gtin CHAR(13), tenant_slug TEXT, tenant_name TEXT, label TEXT, configurator TEXT, total_cents INTEGER, saved_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.gtin, t.slug, t.name, coalesce(cf.definition->>'itemLabel', 'Ensamble'), coalesce(cf.name, ''), b.total_cents, s.created_at
  FROM build_saves s JOIN builds b ON b.id = s.build_id JOIN codes c ON c.build_id = b.id JOIN tenants t ON t.id = b.tenant_id
  LEFT JOIN configurators cf ON cf.id = b.configurator_id
  WHERE s.user_id = uid ORDER BY s.created_at DESC LIMIT 200
$$;
CREATE FUNCTION user_build_detail(uid BIGINT, g TEXT) RETURNS TABLE (name TEXT, qty SMALLINT, unit_price_cents INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.name, bi.qty, bi.unit_price_cents
  FROM build_saves s JOIN codes c ON c.build_id = s.build_id JOIN build_items bi ON bi.build_id = s.build_id JOIN products p ON p.id = bi.product_id
  WHERE s.user_id = uid AND c.gtin = g ORDER BY p.category, p.name
$$;

-- El resolver nombra el artículo configurado con la etiqueta de su configurador.
CREATE OR REPLACE FUNCTION resolve_gtin(g TEXT) RETURNS TABLE (
  tenant_id SMALLINT, kind TEXT, sku TEXT, name TEXT, price_cents INTEGER, retired BOOLEAN,
  product_url_tpl TEXT, build_url_tpl TEXT, allowed_domains TEXT[], link_status TEXT, build_id BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.tenant_id, c.kind, p.sku,
         CASE WHEN c.kind='product' THEN p.name ELSE coalesce(cf.definition->>'itemLabel', 'Ensamble') || ' ' || c.gtin END,
         CASE WHEN c.kind='product' THEN p.price_cents ELSE b.total_cents END,
         c.retired_at IS NOT NULL, t.product_url_tpl, t.build_url_tpl, t.allowed_domains, t.link_status, c.build_id
  FROM codes c JOIN tenants t ON t.id=c.tenant_id
  LEFT JOIN products p ON p.id=c.product_id LEFT JOIN builds b ON b.id=c.build_id
  LEFT JOIN configurators cf ON cf.id=b.configurator_id
  WHERE c.gtin = g
$$;

REVOKE ALL ON FUNCTION public_configurators(), public_tenant(TEXT), register_user(TEXT, TEXT), user_auth(BIGINT), user_builds(BIGINT), user_build_detail(BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_configurators(), public_tenant(TEXT), register_user(TEXT, TEXT), user_auth(BIGINT), user_builds(BIGINT), user_build_detail(BIGINT, TEXT) TO app_rw;
