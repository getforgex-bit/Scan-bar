-- Integración con las páginas web de los negocios (docs/INTEGRACION-WEBS.md):
-- productos que se agregan desde Scan-bar, variantes (talla, tamaño, gramaje) y configuraciones hechas en las webs.

-- origin: quién administra el producto. 'repo' = lo define el código de la web y lo mantiene `npm run sync:repos`;
-- 'scanbar' = se dio de alta en Administración → Productos y la web lo lee del catálogo público.
ALTER TABLE products
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'scanbar' CHECK (origin IN ('repo', 'scanbar')),
  ADD COLUMN description TEXT NOT NULL DEFAULT '',
  ADD COLUMN image_url TEXT,
  -- Variantes: cada talla/tamaño es un producto con su propio GTIN; comparten variant_of (SKU base) y se distinguen por variant.
  ADD COLUMN variant_of TEXT,
  ADD COLUMN variant TEXT,
  ADD CONSTRAINT products_variant_pair CHECK ((variant_of IS NULL) = (variant IS NULL));
CREATE INDEX products_variant_of ON products (tenant_id, variant_of) WHERE variant_of IS NOT NULL;

-- Los negocios sincronizados desde su repositorio antes de esta migración: sus productos los administra el repo.
UPDATE products SET origin = 'repo'
 WHERE tenant_id IN (SELECT id FROM tenants WHERE slug IN ('yokrem', 'cafe-motz', 'dulce-encanto', 'nova-core', 'la-picosita-de-la-sierra', 'biker-lifestyle'));

-- Configuraciones recibidas de una web (sin configurador de Scan-bar): la etiqueta sale de una lista cerrada.
ALTER TABLE builds ADD COLUMN label TEXT;

-- El visor de la consola muestra el origen.
CREATE OR REPLACE VIEW v_products AS SELECT id, tenant_id, sku, name, category, price_cents, stock, active, origin FROM products;

-- Resolver, ficha de respaldo y "Mis configuraciones": la etiqueta propia de la configuración tiene prioridad.
CREATE OR REPLACE FUNCTION resolve_gtin(g TEXT) RETURNS TABLE (
  tenant_id SMALLINT, kind TEXT, sku TEXT, name TEXT, price_cents INTEGER, retired BOOLEAN,
  product_url_tpl TEXT, build_url_tpl TEXT, allowed_domains TEXT[], link_status TEXT, build_id BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.tenant_id, c.kind, p.sku,
         CASE WHEN c.kind='product' THEN p.name ELSE coalesce(b.label, cf.definition->>'itemLabel', 'Ensamble') || ' ' || c.gtin END,
         CASE WHEN c.kind='product' THEN p.price_cents ELSE b.total_cents END,
         c.retired_at IS NOT NULL, t.product_url_tpl, t.build_url_tpl, t.allowed_domains, t.link_status, c.build_id
  FROM codes c JOIN tenants t ON t.id=c.tenant_id
  LEFT JOIN products p ON p.id=c.product_id LEFT JOIN builds b ON b.id=c.build_id
  LEFT JOIN configurators cf ON cf.id=b.configurator_id
  WHERE c.gtin = g
$$;

CREATE OR REPLACE FUNCTION user_builds(uid BIGINT) RETURNS TABLE (gtin CHAR(13), tenant_slug TEXT, tenant_name TEXT, label TEXT, configurator TEXT, total_cents INTEGER, saved_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.gtin, t.slug, t.name, coalesce(b.label, cf.definition->>'itemLabel', 'Ensamble'), coalesce(cf.name, ''), b.total_cents, s.created_at
  FROM build_saves s JOIN builds b ON b.id = s.build_id JOIN codes c ON c.build_id = b.id JOIN tenants t ON t.id = b.tenant_id
  LEFT JOIN configurators cf ON cf.id = b.configurator_id
  WHERE s.user_id = uid ORDER BY s.created_at DESC LIMIT 200
$$;
