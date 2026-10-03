# Operación

Todos los comandos se probaron en este repositorio (Windows 11, Node 24). Lo que no pudo probarse se marca **no verificado**.

## Variables de entorno (sin valores)
`DATABASE_URL` (propietario, solo migraciones/seed), `DB_APP_RW_PASSWORD`, `DB_ADMIN_RO_PASSWORD`, `DB_ADMIN_RW_PASSWORD` (contraseñas de los roles de la aplicación), `TOTP_ENC_KEY` (32 bytes en base64; cifra los secretos TOTP), `RESOLVER_HOST` (host público del resolver, p. ej. `id.ejemplo.mx`), `PORT`, `HOST`, `NODE_ENV`, `TRUST_PROXY` (`1` detrás de un proxy TLS), `SEED_ADMIN_PASSWORD`, `SEED_POS_PASSWORD`. Opcionales: `APP_DATABASE_URL`, `ADMIN_DATABASE_URL`, `ADMIN_RW_DATABASE_URL` si los roles no comparten host con `DATABASE_URL`. Ver `.env.example`.

## Arranque
```bash
npm run dev:db        # desarrollo: Postgres embebido (en otra terminal)
npm run migrate       # esquema + contraseñas de los roles desde el entorno
npm run seed
npm run build && npm start
```
- Las migraciones crean los roles `app_rw`, `admin_ro` y `admin_rw` **sin contraseña**; `npm run migrate` ejecuta `ALTER ROLE … PASSWORD` con `DB_*_PASSWORD`. En desarrollo, si faltan, las genera y las guarda en `.env` (ignorado por git). Con `NODE_ENV=production` nada se inventa: si falta un secreto, `migrate` y el arranque fallan con el nombre de la variable.
- **Rotar la contraseña de un rol**: cambia la variable, ejecuta `npm run migrate` y reinicia la API.
- **`TOTP_ENC_KEY`**: si se pierde, los secretos TOTP guardados no se pueden descifrar y cada SuperAdmin debe volver a activar su segundo factor (`UPDATE users SET totp_enabled=false, totp_secret=NULL`).
- Detrás de un proxy TLS define `TRUST_PROXY=1`; si no, el límite de tasa ve la IP del proxy y la cookie `Secure`/HSTS se deciden con el host interno.

## Cuentas y administración
- Registrarse desde la app crea una cuenta de **cliente** sin permisos. Para dar acceso de operador o SuperAdmin: *Administración → Usuarios* (mismo correo + negocio + rol).
- *Administración* pide la contraseña de la cuenta (vigencia de 15 min, se renueva con el uso; "Bloquear ahora" la cierra) y segundo factor TOTP.
- **Nuevo configurador para un negocio**: 1) *Administración → Productos*: da de alta las opciones (la categoría decide el grupo; los atributos alimentan las reglas; precio 0 = sin costo). 2) *Administración → Configuradores → Nuevo*: define grupos y reglas. El cambio es inmediato para los clientes y queda en `audit_log`.

## Respaldos y restauración
- Con Postgres administrado: respaldo diario con retención de 7 días del proveedor, y `pg_dump`/`pg_restore` para restaurar (**no verificado** aquí: no hay `pg_dump` en el entorno).
- Verificado: `npm run backup-test` hace un respaldo físico en frío de una instancia sembrada, destruye datos en el original, levanta la copia y compara conteos (9 negocios, 71 productos, 71 códigos, 18 usuarios). Ver `docs/ACEPTACION.md`.

## Rotación de llaves de integración
Consola → Llaves: 1) crear llave nueva para el tenant (se muestra una vez), 2) actualizar la web del equipo, 3) desactivar la anterior. Ambas funcionan durante el cambio. Todo queda en `audit_log`.

## Si un tenant cambia su URL
Consola → Tenants → Editar: cambia la plantilla (`{sku}` / `{gtin}`) y los dominios permitidos; "Probar enlace" valida. Los códigos impresos **no cambian** (probado en `tests/api.test.ts`). Si el nuevo host no está en `allowed_domains`, el resolver muestra la ficha de respaldo en lugar de redirigir.

## Otras tareas
- Retirar un código (nunca borrar): `UPDATE codes SET retired_at=now()` (única columna actualizable por `app_rw`); el resolver responde 404 propio.
- Alertas: Consola → Métricas; se evalúan cada 60 s (o "Evaluar ahora").
- Informe de campo: `npm run field-report` (usa `scan_events`; ver pestaña **Campo** de la PWA para imprimir etiquetas y marcar dispositivo/soporte).
- Regenerar `docs/API.md`: `npm run gen-api-docs` (API levantada).
- HTTPS es obligatorio fuera de `localhost` para la cámara.
