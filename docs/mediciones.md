# Mediciones (reales, ejecutadas el 2026-09-30)

**Entorno:** AMD Ryzen 7 4800H (16 hilos), 23.4 GB RAM, Windows 11, Node 24, PostgreSQL 18 embebido, todo **local** (API, BD y cliente de carga en la misma máquina). No representa un servidor remoto ni un teléfono.

## Generación de SVG en servidor (bwip-js, sin caché) — `npx tsx scripts/bench-svg.ts`
| Símbolo | n | media | p50 | p95 |
|---|---|---|---|---|
| EAN-13 (con texto) | 500 (+20 calentamiento) | 1.25 ms | 1.20 ms | 1.56 ms |
| QR (Digital Link, EC M) | 500 (+20) | 4.64 ms | 4.72 ms | 5.41 ms |

Umbral del plan: p95 < 60 ms → **cumple** (no hace falta caché adicional; ya existe caché en memoria por GTIN).

## `POST /v1/builds` con SVG incluido — `npx tsx scripts/load-builds.ts 20 120`
20 peticiones/s durante 120 s, 2 400 peticiones, BOM variados cambiando cantidades.

| Peticiones | Ensambles nuevos | Errores | p50 | p95 | p99 | máx |
|---|---|---|---|---|---|---|
| 2 400 | 864 | 0 (0 %) | 5.2 ms | 17.1 ms | 20.5 ms | 164.7 ms |

Las otras 1 536 repiten un BOM ya guardado (camino de reutilización, más barato): solo 864 BOM distintos disponibles con esa combinación. Umbral: p95 < 200 ms → **cumple en local**. Pendiente repetir en el servidor de despliegue y con BOM 100 % nuevos.

## Decodificación en navegador (motor Wasm autoalojado, Chromium del panel de la herramienta)
Imágenes **estáticas** (los SVG generados por el propio servidor, ampliados ×2 en canvas), 20 repeticiones tras calentamiento:

| Símbolo | Resultado | p50 | p95 |
|---|---|---|---|
| EAN-13 | `7500002000273` leído correctamente | 5.4 ms | 10.0 ms |
| QR | `http://localhost:3000/01/07500002000273` leído; el GTIN se extrae por `/01/` | 3.2 ms | 3.9 ms |

Esto solo prueba que el decodificador lee lo que el servidor dibuja y su costo de decodificación en escritorio. **No** es la medición de la puerta de F2 (cámara real, cuadro→resultado, 3 dispositivos).

## Matriz de campo (3 dispositivos × 30 lecturas)
| Dispositivo | Soporte | Lecturas | Éxito | decode p50 | decode p95 |
|---|---|---|---|---|---|
| Android gama baja / Chrome | etiqueta 100 % y 80 % | sin datos | sin datos | sin datos | sin datos |
| iPhone / Safari | etiqueta 100 % | sin datos | sin datos | sin datos | sin datos |
| Laptop Windows / Chrome + webcam | etiqueta 100 % | sin datos | sin datos | sin datos | sin datos |

La PWA ya envía `engine`, `decodeMs` y `totalMs` a `scan_events` en cada lectura; falta la vista `v_latency_p95` y la sesión de campo.

## Auditoría de accesibilidad (axe-core 4.13, ejecutada el 2026-09-30)
Ejecutada con axe-core inyectado en el navegador integrado sobre las 11 pantallas (Escáner en ambos modos, Configurador, Catálogo y las 7 secciones de la Consola) a 1230 px y, las principales, a 390 px.
- Primera pasada: 1 infracción **seria** (`scrollable-region-focusable` en el visor de BD) y 2 menores (`empty-table-header`). Corregidas.
- Pasada final: **0 infracciones** en todas las pantallas auditadas; sin desplazamiento horizontal a 390 px.
- Limitaciones: no es Playwright (no instalado); el contraste de los tokens lo evalúa axe, pero la revisión visual contra la sección 7 por una persona del equipo **sigue pendiente**.

## Repetición tras los cambios del 2026-10-01 (motor de configuradores genérico, cabeceras de seguridad, límite de tasa)
Mismo entorno local. `POST /v1/builds` con sesión de operador, 20 peticiones/s × 120 s (`LOAD_VARIANT` cambia CPU y placa para crear BOM nuevos):

| Corrida | Ensambles nuevos | Errores | p50 | p95 | p99 | máx |
|---|---|---|---|---|---|---|
| 1 (todo reutilizado) | 0 | 0 | 7 586 ms | **9 779 ms** | 9 866 ms | 272 027 ms |
| 2 (todo reutilizado, 60 s) | 0 | 0 | 4.9 ms | 7.0 ms | 10.2 ms | 78.9 ms |
| 3 (todo reutilizado) | 0 | 0 | 5.0 ms | 6.3 ms | 8.1 ms | 60.7 ms |
| 4 (`LOAD_VARIANT=1`) | 864 | 0 | 5.5 ms | 14.9 ms | 17.3 ms | 32.2 ms |

**La corrida 1 no cumple la meta (p95 < 200 ms) y no se pudo reproducir**: las tres siguientes, con el mismo código y la misma base, quedaron en 6–15 ms. Durante las corridas 2 y 3 se muestreó `pg_stat_activity` cada 5 s y no hubo esperas por candados ni transacciones largas. La causa del atasco de la corrida 1 queda **sin identificar** (un máximo de 272 s en una prueba de 120 s apunta a una pausa del proceso o de la máquina, pero no hay evidencia). Antes de dar por bueno el criterio 3 conviene repetir la prueba en el servidor de despliegue y vigilar si reaparece.

## Auditoría de accesibilidad tras los cambios (axe-core 4.13, 2026-10-01)
0 infracciones en: configurador anónimo (café), diálogo de registro/entrada, Mis configuraciones, Administración (pantalla de contraseña, Configuradores, editor JSON, Productos) y configurador con sesión de personal, a ancho de escritorio; y en Escáner, Configurador, Mis configuraciones, Catálogo y Administración a 390 px, sin desplazamiento horizontal. Mismas limitaciones que la auditoría anterior.

## Auditoría de accesibilidad de la versión simplificada (axe-core 4.13, Playwright + Chromium 141, 2026-10-03)
Etiquetas `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` y `best-practice`, con la app en modo producción (CSP real) sobre la base sincronizada con las seis webs (245 productos).
- Pantallas: Escáner de visitante (1280 px y 390 px), diálogo Entrar, Caja y Catálogo con cuenta de caja, activación del segundo factor, y en la consola Productos y etiquetas (antes y después de agregar un producto con variantes), Negocios, Usuarios, Métricas, Llaves, Base de datos y Depurador.
- Resultado: **0 infracciones** en las 14 pasadas. Único resultado "incompleto": `video-caption` en la vista de la cámara (vídeo en vivo, no aplica).
- Control: la misma inyección sobre una página con errores conocidos sí reporta 8 reglas (`image-alt`, `button-name`, `label`…), así que la auditoría no es un falso negativo.
- Limitaciones: el navegador no tiene cámara (se audita el estado "sin cámara" con captura manual); la revisión con lector de pantalla por una persona sigue pendiente.
