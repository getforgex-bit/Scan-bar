-- El contenido de un artículo configurado se lista en el orden de los grupos de su configurador
-- (bebida, tamaño, leche…), no alfabético por categoría.
CREATE FUNCTION group_order(def JSONB, cat TEXT) RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce((SELECT ord::int FROM jsonb_array_elements(coalesce(def->'groups', '[]'::jsonb)) WITH ORDINALITY AS g(v, ord)
                   WHERE v->>'category' = cat LIMIT 1), 999)
$$;

CREATE OR REPLACE FUNCTION resolve_build_bom(bid BIGINT) RETURNS TABLE (name TEXT, qty SMALLINT, unit_price_cents INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.name, bi.qty, bi.unit_price_cents
  FROM build_items bi JOIN products p ON p.id=bi.product_id JOIN builds b ON b.id=bi.build_id LEFT JOIN configurators cf ON cf.id=b.configurator_id
  WHERE bi.build_id=bid ORDER BY group_order(cf.definition, p.category), p.name
$$;

CREATE OR REPLACE FUNCTION user_build_detail(uid BIGINT, g TEXT) RETURNS TABLE (name TEXT, qty SMALLINT, unit_price_cents INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.name, bi.qty, bi.unit_price_cents
  FROM build_saves s JOIN codes c ON c.build_id = s.build_id JOIN builds b ON b.id = s.build_id
  JOIN build_items bi ON bi.build_id = s.build_id JOIN products p ON p.id = bi.product_id
  LEFT JOIN configurators cf ON cf.id = b.configurator_id
  WHERE s.user_id = uid AND c.gtin = g ORDER BY group_order(cf.definition, p.category), p.name
$$;
