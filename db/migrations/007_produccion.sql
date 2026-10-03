-- Producción en un Postgres administrado (Neon, Supabase…) y en un contenedor que se duerme:
-- 1) los roles de la consola ven todos los tenants por política, no por BYPASSRLS;
-- 2) las sesiones viven en la base (sobreviven reinicios del contenedor).

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','products','code_counters','builds','build_items','codes','sales','sale_items','scan_events','configurators','build_saves'] LOOP
    IF NOT EXISTS (SELECT FROM pg_policies WHERE tablename = t AND policyname = 'admin_all') THEN
      EXECUTE format('CREATE POLICY admin_all ON %I TO admin_ro, admin_rw USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;

CREATE TABLE sessions (
  id         CHAR(64) PRIMARY KEY,  -- sha256 del identificador de la cookie (nunca el identificador en claro)
  user_id    BIGINT NOT NULL,
  data       JSONB NOT NULL,        -- { tenantId, role, email, totp, adminUntil }
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app_rw;
GRANT SELECT, DELETE ON sessions TO admin_rw;  -- cerrar las sesiones de una cuenta cuya contraseña cambió
