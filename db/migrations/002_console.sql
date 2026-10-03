-- F3: TOTP, llaves, depurador, métricas, alertas, tiempo real

ALTER TABLE users ADD COLUMN totp_secret TEXT, ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE recovery_codes (
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES users(id),
  code_hash CHAR(64) NOT NULL, used_at TIMESTAMPTZ
);
CREATE TABLE api_keys (
  id BIGSERIAL PRIMARY KEY, tenant_id SMALLINT NOT NULL REFERENCES tenants(id),
  prefix TEXT NOT NULL, key_hash CHAR(64) NOT NULL UNIQUE,
  scope TEXT[] NOT NULL DEFAULT '{builds:create,catalog:read}',
  active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, tenant_id SMALLINT, message TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX alerts_one_active ON alerts (kind, coalesce(tenant_id, 0)) WHERE active;
ALTER TABLE http_log ADD COLUMN headers JSONB, ADD COLUMN query TEXT, ADD COLUMN url TEXT;
CREATE INDEX http_log_req ON http_log (request_id);
CREATE INDEX http_log_created ON http_log (created_at);
CREATE INDEX scan_events_created ON scan_events (created_at);

-- Rol de escritura de la consola (solo tablas de administración; opera entre tenants por la política admin_all de 007)
DO $r$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='admin_rw') THEN CREATE ROLE admin_rw NOLOGIN; END IF;
END $r$;
GRANT USAGE ON SCHEMA public TO admin_rw;
GRANT SELECT, INSERT, UPDATE ON tenants, users, memberships, api_keys, code_counters, recovery_codes TO admin_rw;
GRANT SELECT, INSERT, UPDATE ON products, codes TO admin_rw;
GRANT INSERT, SELECT ON audit_log TO admin_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO admin_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO admin_ro, admin_rw;
GRANT SELECT, INSERT, UPDATE ON alerts TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
GRANT SELECT, INSERT, DELETE ON http_log TO app_rw;

-- Autenticación por llave (SECURITY DEFINER; solo devuelve lo necesario)
CREATE FUNCTION api_key_lookup(h TEXT) RETURNS TABLE (tenant_id SMALLINT, scope TEXT[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id, scope FROM api_keys WHERE key_hash = h AND active
$$;
CREATE FUNCTION user_totp(uid BIGINT) RETURNS TABLE (totp_secret TEXT, totp_enabled BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT totp_secret, totp_enabled FROM users WHERE id = uid
$$;
CREATE FUNCTION use_recovery_code(uid BIGINT, h TEXT) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  WITH u AS (UPDATE recovery_codes SET used_at = now() WHERE user_id = uid AND code_hash = h AND used_at IS NULL RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;
REVOKE ALL ON FUNCTION api_key_lookup(TEXT), user_totp(BIGINT), use_recovery_code(BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api_key_lookup(TEXT), user_totp(BIGINT), use_recovery_code(BIGINT, TEXT) TO app_rw;

-- ===== Métricas (sección 6) =====
CREATE VIEW v_latency_p95 AS
  SELECT engine, coalesce(device, 'desconocido') AS device, count(*)::int AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY decode_ms) AS decode_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY decode_ms) AS decode_p95,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS total_p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS total_p95
  FROM scan_events WHERE decode_ms IS NOT NULL AND engine <> 'manual' GROUP BY engine, coalesce(device, 'desconocido');
CREATE VIEW v_resolution_rate AS
  SELECT tenant_id, count(*)::int AS total, count(*) FILTER (WHERE result = 'resolved')::int AS resolved,
         round(100.0 * count(*) FILTER (WHERE result = 'resolved') / nullif(count(*), 0), 2) AS pct
  FROM scan_events GROUP BY tenant_id;
CREATE VIEW v_build_p95 AS
  SELECT count(*)::int AS n, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
  FROM http_log WHERE method = 'POST' AND route = '/v1/builds' AND status < 300;
CREATE VIEW v_error_rate_15m AS
  SELECT count(*)::int AS total, count(*) FILTER (WHERE status >= 500)::int AS errors,
         round(100.0 * count(*) FILTER (WHERE status >= 500) / nullif(count(*), 0), 2) AS pct
  FROM http_log WHERE created_at > now() - interval '15 minutes';
CREATE VIEW v_link_health AS SELECT id AS tenant_id, slug, link_status FROM tenants;
CREATE VIEW v_sales_by_box AS
  SELECT tenant_id, date_trunc('day', created_at)::date AS day, count(*)::int AS sales, sum(total_cents)::bigint AS total_cents
  FROM sales GROUP BY tenant_id, date_trunc('day', created_at);
CREATE MATERIALIZED VIEW mv_latency_hourly AS
  SELECT date_trunc('hour', created_at) AS hour, engine, count(*)::int AS n,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY decode_ms) AS decode_p95,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS total_p95
  FROM scan_events WHERE decode_ms IS NOT NULL AND engine <> 'manual' GROUP BY 1, 2;
CREATE FUNCTION refresh_metrics() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  REFRESH MATERIALIZED VIEW mv_latency_hourly
$$;
GRANT SELECT ON v_latency_p95, v_resolution_rate, v_build_p95, v_error_rate_15m, v_link_health, v_sales_by_box, mv_latency_hourly TO admin_ro, admin_rw;
REVOKE ALL ON FUNCTION refresh_metrics() FROM PUBLIC; GRANT EXECUTE ON FUNCTION refresh_metrics() TO app_rw;

-- ===== Alertas: umbrales de la sección 6 =====
CREATE FUNCTION evaluate_alerts() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; pct NUMERIC; tot INT;
BEGIN
  -- Tasa de resolución < 95 % (ventana de 15 min, mínimo 20 escaneos)
  SELECT count(*), 100.0 * count(*) FILTER (WHERE result = 'resolved') / nullif(count(*), 0) INTO tot, pct
    FROM scan_events WHERE created_at > now() - interval '15 minutes';
  PERFORM set_alert('resolution_rate', NULL, tot >= 20 AND pct < 95, format('Tasa de resolución %s %% (< 95 %%)', round(pct, 1)));
  -- Error 5xx > 2 % (ventana de 15 min, mínimo 20 peticiones)
  SELECT count(*), 100.0 * count(*) FILTER (WHERE status >= 500) / nullif(count(*), 0) INTO tot, pct
    FROM http_log WHERE created_at > now() - interval '15 minutes';
  PERFORM set_alert('error_rate', NULL, tot >= 20 AND pct > 2, format('Tasa de error API %s %% (> 2 %%)', round(pct, 1)));
  -- Enlace en down
  FOR r IN SELECT id, slug, link_status FROM tenants LOOP
    PERFORM set_alert('link_down', r.id, r.link_status = 'down', format('El enlace de %s está caído', r.slug));
  END LOOP;
END $$;
CREATE FUNCTION set_alert(k TEXT, t SMALLINT, firing BOOLEAN, msg TEXT) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF firing THEN
    INSERT INTO alerts (kind, tenant_id, message) VALUES (k, t, msg) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE alerts SET active = false, resolved_at = now() WHERE kind = k AND coalesce(tenant_id, 0) = coalesce(t, 0) AND active;
  END IF;
END $$;
REVOKE ALL ON FUNCTION evaluate_alerts(), set_alert(TEXT, SMALLINT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluate_alerts() TO app_rw;

-- ===== Tiempo real: pg_notify =====
CREATE FUNCTION notify_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('events', json_build_object('type', TG_ARGV[0], 'tenant_id', NEW.tenant_id, 'id', NEW.id, 'at', now(),
     'detail', to_jsonb(NEW)->>(CASE TG_ARGV[0] WHEN 'scan' THEN 'result' WHEN 'sale' THEN 'total_cents' ELSE 'message' END))::text);
  RETURN NEW;
END $$;
CREATE TRIGGER scan_notify AFTER INSERT ON scan_events FOR EACH ROW EXECUTE FUNCTION notify_event('scan');
CREATE TRIGGER sale_notify AFTER INSERT ON sales FOR EACH ROW EXECUTE FUNCTION notify_event('sale');
CREATE TRIGGER alert_notify AFTER INSERT ON alerts FOR EACH ROW EXECUTE FUNCTION notify_event('alert');
CREATE FUNCTION notify_error() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status >= 500 THEN PERFORM pg_notify('events', json_build_object('type','error','tenant_id',NEW.tenant_id,'id',NEW.id,'at',now(),'detail',NEW.route || ' ' || NEW.status)::text); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER http_notify AFTER INSERT ON http_log FOR EACH ROW EXECUTE FUNCTION notify_error();
