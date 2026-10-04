-- Tarjetas de acceso: un QR impreso por negocio que inicia sesión como su caja sin escribir contraseña.
-- Es una credencial física (como una llave): solo se guarda el sha256 del token, hay una sola activa por negocio, se puede
-- desactivar, y nunca sirve para el SuperAdmin (solo membresías operador_pos).

CREATE TABLE access_cards (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    SMALLINT NOT NULL REFERENCES tenants(id),
  user_id      BIGINT NOT NULL REFERENCES users(id),
  token_hash   CHAR(64) NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT REFERENCES users(id),
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  uses         INT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX access_cards_una_activa ON access_cards (tenant_id) WHERE revoked_at IS NULL;

ALTER TABLE access_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_cards
  USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::smallint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true),'')::smallint);
CREATE POLICY admin_all ON access_cards TO admin_ro, admin_rw USING (true) WITH CHECK (true);
GRANT SELECT ON access_cards TO admin_ro;
GRANT SELECT, INSERT, UPDATE ON access_cards TO admin_rw;
GRANT USAGE, SELECT ON SEQUENCE access_cards_id_seq TO admin_rw;

-- Entrar con la tarjeta (SECURITY DEFINER: app_rw no ve la tabla). Solo si la tarjeta sigue activa y la cuenta sigue siendo
-- caja de ese negocio; cuenta el uso.
CREATE FUNCTION access_card_login(h TEXT) RETURNS TABLE (user_id BIGINT, tenant_id SMALLINT, email TEXT)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE access_cards a SET last_used_at = now(), uses = a.uses + 1
    FROM users u, memberships m
   WHERE a.token_hash = h AND a.revoked_at IS NULL
     AND u.id = a.user_id AND m.user_id = a.user_id AND m.tenant_id = a.tenant_id AND m.role = 'operador_pos'
  RETURNING a.user_id, a.tenant_id, u.email
$$;
REVOKE ALL ON FUNCTION access_card_login(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_card_login(TEXT) TO app_rw;
