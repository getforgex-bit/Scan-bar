# Criterios de aceptación (sección 9) — estado con evidencia

Estado a 2026-10-01. **Cumplido** solo si hay evidencia ejecutada; lo demás se declara pendiente.

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 1 | 100 % de GTIN con 13 dígitos y módulo 10 | ✅ Cumplido | `packages/codes/src/index.test.ts` (fast-check, mutación de un dígito), CHECK `gtin_check_ok` en `codes` (`tests/db.test.ts`), 50 altas concurrentes válidas (`tests/api.test.ts`) |
| 2 | Decodificación p95 < 300 ms en 3 dispositivos | ❌ **Sin evidencia** | Solo hay medición de decodificador sobre imágenes estáticas en escritorio (p95 10 ms, `docs/mediciones.md`). Matriz de campo: "sin datos" (`docs/campo/informe.md`). Requiere teléfonos reales. |
| 3 | `POST /v1/builds` p95 < 200 ms con SVG | 🟡 Cumple **en local, con una corrida anómala** | Última corrida con 864 ensambles nuevos: p95 14.9 ms, 0 errores (20 rps × 120 s). Una corrida anterior del mismo día dio p95 9.8 s y no se reprodujo en tres repeticiones; causa sin identificar (`docs/mediciones.md`). Falta repetir en el servidor de despliegue. |
| 4 | Escanear un ensamble reconstruye su BOM y total congelado | ✅ Cumplido | `tests/api.test.ts` («mismo BOM… reconstrucción por escaneo», «cambiar un precio…») |
| 5 | Un tenant no lee/escribe datos de otro | ✅ Cumplido | `tests/db.test.ts` (RLS), `tests/api.test.ts` (403/422 cruzados, componente de otro tenant) |
| 6 | Códigos impresos no se rompen al cambiar la URL | ✅ Cumplido | `tests/api.test.ts` «criterio 6» (mismo GTIN → nueva plantilla) |
| 7 | Operador POS no abre consola ni visor de BD | ✅ Cumplido | `tests/console.test.ts` (403 en todas las rutas `/v1/admin/*`); también para cuentas de cliente (`tests/public.test.ts`) |
| 8 | Venta reintentada con la misma Idempotency-Key se registra una vez | ✅ Cumplido | `tests/api.test.ts` (doble envío y 20 simultáneos) |

Otras verificaciones: respaldo y restauración (`npm run backup-test`: before = restored = 9 negocios / 71 productos / 71 códigos / 18 usuarios, tras el desastre 0 productos); `npm audit`: 0 vulnerabilidades; axe-core: 0 infracciones (`docs/mediciones.md`).
