-- Tarjetas de acceso reimprimibles: además del sha256 (para validar), el token se guarda cifrado con TOTP_ENC_KEY
-- (AES-256-GCM, como los secretos TOTP) para volver a imprimir la misma tarjeta sin invalidar las ya entregadas.
-- Las tarjetas anteriores a esta migración no tienen copia: al descargarlas se emite una nueva.
ALTER TABLE access_cards ADD COLUMN token_enc TEXT;
