# Sistema Universal de Códigos — prototipo

Resolver central de códigos EAN-13 / QR (GS1 Digital Link) para varios negocios, con escáner PWA, mini POS y un **configurador genérico**
(PC a medida, bebidas de cafetería o lo que cada negocio defina) que emite un código por cada configuración guardada.
Diseño: [docs/arquitectura.md](docs/arquitectura.md). Límites y desviaciones: [docs/LIMITES.md](docs/LIMITES.md). Mediciones: [docs/mediciones.md](docs/mediciones.md).

## Levantarlo (Windows/macOS/Linux, solo Node ≥ 22)

```bash
npm i
npm run dev:db      # Postgres embebido en :5433 (déjalo corriendo en otra terminal)
npm run migrate     # esquema + contraseñas de los roles de base (en desarrollo se generan en .env)
npm run seed        # 9 negocios de ejemplo; genera .dev-credentials.txt si no defines SEED_*_PASSWORD
npm run build && npm start        # API + PWA en http://localhost:3000
```

La app **se usa sin iniciar sesión**: cualquiera puede escanear (modo Navegación) y usar el configurador de un negocio
(también en `/t/<slug>/configurador`, p. ej. `/t/tienda-0003/configurador`). Iniciar sesión es opcional:

| Quién | Cómo entra | Qué añade |
|---|---|---|
| Visitante | sin cuenta | escanear, configurar y obtener el código |
| Cliente | **Registrarse** (correo + contraseña ≥ 12) | sus configuraciones quedan en *Mis configuraciones* |
| Operador | `caja1..9@ejemplo.mx` | modo Caja (mini POS) y catálogo de su negocio |
| SuperAdmin | `admin1..9@ejemplo.mx` | *Administración*: pide **contraseña** (se bloquea a los 15 min sin uso) y segundo factor (TOTP) |

Contraseñas de la semilla en `.dev-credentials.txt` (o `SEED_ADMIN_PASSWORD` / `SEED_POS_PASSWORD`). Registrarse nunca da permisos de personal:
esos los asigna un administrador en *Administración → Usuarios*.

Negocios de ejemplo con configurador: `tienda-0002` (Cómputo Nova, PC a medida) y `tienda-0003` (Café Origen: bebida, tamaño, leche, endulzante, extras).
Para otro negocio: *Administración → Productos* (opciones con categoría y atributos) y *Administración → Configuradores* (grupos y reglas en JSON, sin desplegar).

La cámara exige HTTPS salvo en `localhost`. Para probar desde un teléfono, expón la app con un túnel HTTPS.

## Qué incluye
- **Códigos**: `packages/codes` (GTIN-13, módulo 10, Digital Link), SVG EAN-13/QR (`GET /v1/codes/:gtin.svg`), resolver `GET /01/:gtin14` con ficha de respaldo y anti redirección abierta.
- **Aislamiento**: PostgreSQL con RLS por `tenant_id`, `withTenant()`, roles `app_rw` (sujeto a RLS), `admin_ro` y `admin_rw`, con contraseñas tomadas del entorno.
- **Cuentas**: Argon2id, cookie HttpOnly/SameSite=Lax/Secure (salvo localhost), bloqueo tras 5 intentos, registro de clientes, contraseña + TOTP (cifrado en reposo) para administración.
- **Seguridad**: CSP sin scripts ni estilos en línea, HSTS, X-Frame-Options, límite de tasa por IP en todo lo público.
- **PWA**: lector con BarcodeDetector nativo o Wasm autoalojado, consenso de 2 lecturas, antirrebote, captura manual; modos Navegación/Caja; ventas idempotentes con cola sin red; ticket de 80 mm.
- **Configurador genérico**: grupos y reglas como datos por negocio (`equals`, `in`, `sum_lte`, `forbid`, `require`), evaluados igual en cliente y servidor; contenido con precio congelado; GTIN determinista por hash.
- **Administración**: negocios, configuradores, productos, usuarios, llaves, visor de BD, depurador, métricas, alertas y eventos en vivo.

## Pruebas

```bash
npm test            # 66 pruebas: GTIN, motor de reglas, RLS, API, ventas, configuradores, uso sin sesión, registro, seguridad, consola, TOTP, alertas, SSE
npm run typecheck
npm run check:resolver   # con la API levantada: 9 de 9 redirecciones
npm run backup-test      # respaldo en frío + restauración verificada
```
