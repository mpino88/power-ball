# Power Ball Bot — Base de Conocimientos Completa

## 1. Visión General del Proyecto

**Power Ball Bot** es un bot de Telegram desarrollado en TypeScript que proporciona resultados, estadísticas y predicciones de la Florida Lottery para los juegos **Pick 3** (Fijo) y **Pick 4** (Corrido). Utiliza el framework **grammY** para la comunicación con Telegram y se despliega en **Render** como Web Service con webhook.

### Stack Tecnológico

- **Runtime**: Node.js 18+
- **Lenguaje**: TypeScript (strict mode, ES2022, NodeNext modules)
- **Framework de bot**: grammY v1.28+
- **Persistencia**: Google Sheets (producción) o archivos JSON locales (desarrollo)
- **IA generativa**: Google Gemini API (para la funcionalidad de Adivinanzas)
- **Scraping**: Puppeteer (para resultados en tiempo real de la web oficial) + pdfjs-dist (para PDFs históricos)
- **Despliegue**: Render (Web Service gratuito con Blueprint YAML)

### Fuentes de Datos

1. **PDFs oficiales de Florida Lottery**: `https://files.floridalottery.com/exptkt/p3.pdf` y `p4.pdf` — contienen el historial completo de sorteos. Se descargan, parsean con pdfjs-dist y se cachean en memoria.
2. **Scraping web** (opcional, Puppeteer): para obtener los resultados del día actual desde la página oficial de Florida Lottery.
3. **Google Sheets**: almacena usuarios, estrategias, planes y configuración del bot.

---

## 2. Arquitectura del Sistema

### Estructura de Directorios

```
src/
├── bot.ts                  # Punto de entrada, orquestador principal
├── florida-lottery.ts      # Scraping web con Puppeteer
├── user-config.ts          # Gestión de usuarios, permisos, planes, persistencia
├── plans.ts                # CRUD de planes de suscripción
├── custom-menus.ts         # CRUD de estrategias (menús personalizados)
├── menu-registry.ts        # Registro central de menús/handlers
├── stats-p3.ts             # Motor de estadísticas (grupos e individuales)
├── charada.ts              # Charada Cubana (numerología)
├── adivinanza.ts           # Generador de adivinanzas con IA (Gemini)
├── downtack.ts             # Cliente API DOWNTACK (alternativa de datos)
├── menus/                  # Sistema de menús y teclados
│   ├── types.ts            # Tipo GameMenu
│   ├── keyboards.ts        # Constructores de InlineKeyboard
│   ├── handlers.ts         # Handlers de callbacks de menú
│   └── index.ts            # Barrel export
├── security/               # Control de acceso y panel de administración
│   ├── middleware.ts        # Middleware de restricción de acceso
│   ├── callbacks.ts         # Handlers de callbacks admin/usuario
│   ├── flows.ts             # Máquinas de estado para wizards
│   ├── keyboards.ts         # Teclados del panel admin
│   ├── messageHandler.ts    # Handler de mensajes de texto en flujos
│   ├── menuIdFromLabel.ts   # Generador de slugs para IDs
│   └── index.ts             # Barrel export
└── strategies/             # Motor de estrategias predictivas
    ├── types.ts             # Tipos base (StrategyDefinition, etc.)
    ├── index.ts             # Registro y ejecución de estrategias
    ├── utils.ts             # Utilidades compartidas
    ├── context-menu.ts      # Teclado estándar de contexto
    ├── freq-analysis.ts     # Análisis de Frecuencia
    ├── gap-due.ts           # Números Debidos (Gap)
    ├── calendar-pattern.ts  # Patrón Calendario
    ├── transition-follow.ts # Seguidor de Secuencias (Markov 1)
    ├── trend-momentum.ts    # Momentum de Tendencia
    ├── positional-analysis.ts # Análisis Posicional
    ├── max-per-week-day.ts  # Más salidores por día de la semana
    ├── est-individuales.ts  # Estadísticas Individuales (Hot)
    ├── markov-order2.ts     # Markov Orden 2
    ├── max-gap-breach.ts    # Récord de Ausencia Roto
    ├── decade-family.ts     # Familias de Decenas
    ├── mirror-complement.ts # Espejo y Complemento
    ├── terminal-analysis.ts # Análisis de Terminales
    ├── cycle-detector.ts    # Detector de Ciclos
    ├── streak-analysis.ts   # Análisis de Rachas
    ├── bayesian-score.ts    # Score Bayesiano
    ├── unodostres.ts        # Resonancia Fibonacci (1-2-3)
    ├── consensus-multi.ts   # Consenso Multi-Estrategia
    ├── parle.ts             # Generador de Parlés
    └── progressive.ts       # Back-testing Progresivo
```

### Flujo de Ejecución Principal

1. **Arranque** (`main()` en `bot.ts`):
   - Registra los menús extra integrados (est_grupos).
   - Inicializa la configuración de usuarios desde Google Sheet o JSON local.
   - Carga estrategias y planes desde el Sheet.
   - Registra handlers para cada estrategia (con handler real si tiene StrategyDefinition, o placeholder si es custom sin lógica).
   - Siembra las estrategias built-in que no existan en el catálogo.
   - Precarga los PDFs de P3 y P4 en paralelo.
   - Configura los comandos del bot (/start, /help, /cancel).
   - Si hay WEBHOOK_URL: levanta un servidor HTTP y configura el webhook. Si no: inicia en modo long polling.

2. **Procesamiento de mensajes**: Cada mensaje pasa por el middleware de restricción de acceso antes de llegar a los handlers.

---

## 3. Sistema de Acceso y Seguridad

### Roles

- **Owner (Dueño)**: definido por `BOT_OWNER_ID` (soporta múltiples IDs separados por comas). Tiene acceso completo a todas las funciones, panel de administración y funciones exclusivas como Testing, Adivinanzas y Análisis Progresivo.
- **Usuario autorizado**: figura en la whitelist. Tiene acceso al bot limitado a las estrategias de su plan y las asignadas explícitamente.
- **Usuario no autorizado**: ve la pantalla de selección de plan para solicitar acceso.

### Middleware de Restricción

El middleware se ejecuta en cada actualización y sigue esta lógica:

1. Si el usuario es owner → pasa siempre.
2. Si el usuario está autorizado pero su plan expiró → muestra opciones de renovación. Los planes auto-approve y trials de 2 días se activan al instante. Los planes de pago inician un flujo de contacto telefónico.
3. Si el usuario no está autorizado → muestra los planes disponibles con botones de temporalidad. Los planes trial (2 días) se auto-aprueban una sola vez por usuario. Los planes pagos requieren contacto telefónico y aprobación manual del admin.

### Panel de Administración (/admin)

Accesible solo para el owner. Funcionalidades:

- **Usuarios**: listar todos (hasta 30) con ID, nombre, teléfono, plan, estado.
- **Acceso**: agregar usuarios (wizard de 3 pasos: ID → Nombre → Teléfono) o revocar acceso.
- **Estrategias por usuario**: asignar o quitar estrategias individuales a cualquier usuario.
- **Gestionar Estrategias**: crear nuevas (wizard 3 pasos: título → descripción → precio), eliminar, cambiar visibilidad (pública/privada), aprobar/rechazar solicitudes de acceso.
- **Gestionar Planes**: crear (wizard 8 pasos), editar, eliminar, asignar a usuarios, aprobar solicitudes de cambio de plan, gestionar menús incluidos por plan.

---

## 4. Sistema de Planes de Suscripción

### Temporalidades Disponibles

| ID | Etiqueta | Duración |
|----|----------|----------|
| 1d | Trial (2 días) | 2 días (auto-approve, una sola vez por usuario) |
| 1m | 1 Mes | 30 días |
| 3m | 3 Meses | 90 días |
| 6m | 6 Meses | 180 días |
| 9m | 9 Meses | 270 días |
| 1a | 1 Año | 365 días |

### Planes Por Defecto

1. **Básico**: incluye est_grupos. Sin precios definidos.
2. **Pro**: incluye est_grupos + est_individuales. Sin precios definidos.
3. **Trial**: incluye est_grupos. Auto-approve habilitado.

Cada plan define qué estrategias (menuIds) incluye y precios por temporalidad (price_1m, price_3m, price_6m, price_9m, price_1a). Los usuarios reciben automáticamente las estrategias de su plan activo.

### Flujo de Solicitud de Plan

1. El usuario elige un plan y temporalidad desde el menú principal.
2. Si es trial (1d) y no lo ha usado → se activa automáticamente.
3. Si es plan pagado → se le pide compartir su contacto telefónico → se registra la solicitud → el admin la aprueba/rechaza desde el panel.
4. El admin puede asignar planes directamente sin solicitud.

### Expiración

- La fecha de expiración se calcula como `fecha_inicio + duración_temporalidad`.
- Se almacena en formato MM/DD/YY en la columna `plan_expiry` del Sheet.
- `isPlanExpired()` compara con la fecha actual en zona horaria de Florida (America/New_York).
- Cuando un plan expira, el middleware intercepta al usuario y le muestra opciones de renovación.

---

## 5. Persistencia de Datos

### Google Sheets (Producción)

El bot utiliza Google Sheets como base de datos principal cuando están configurados `GOOGLE_SHEET_ID` y `GOOGLE_SERVICE_ACCOUNT_JSON`.

**Pestañas del Sheet:**

1. **Pestaña 1 — Usuarios**: columnas userId, nombre, telefono, menus, menus_labels, plan, plan_status, pending_plan, plan_temporality, plan_expiry, trial_used.
2. **Pestaña 2 — Estrategias**: columnas id, titulo, descripcion, createdBy, price, visibility, subscribers.
3. **Pestaña 3 — Planes**: columnas id, title, description, price, menuIds, price_1m, price_3m, price_6m, price_9m, price_1a, autoApprove.
4. **Pestaña 4 — SolicitudesEstrategias**: columnas id, userId, menuId, timestamp.
5. **Pestaña 5 — Testing**: celda A2 contiene la fecha de corte para el modo testing.

### Archivos JSON (Desarrollo Local)

Cuando el Sheet no está disponible, se usan archivos en `data/`:
- `data/bot-users.json`: whitelist de usuarios y configuración.
- `data/extra-menus.json`: catálogo de estrategias.
- `data/plans.json`: catálogo de planes.

### Caché y TTL

- **PDFs de P3/P4**: se descargan una vez al iniciar y se cachean en memoria indefinidamente.
- **Scrape de "Hoy"**: caché de 10 minutos.
- **Configuración de usuarios**: refresh cada 3 minutos (stale check).
- **Fecha de corte Testing**: caché de 5 minutos.
- **Modelos Gemini**: se descubren al ejecutar el comando `/gemini_modelos`, sin caché.

---

## 6. Sistema de Menús y Navegación

### Menú Principal

Al ejecutar /start o pulsar "Volver", el usuario ve:

- **📊 Consultar Datos** — accede a resultados de sorteos.
- **➕ Estrategias** — submenu con las estrategias asignadas al usuario (excluyendo Consenso).
- **🤝 Consenso Multi-Estrategia** — cruza varias estrategias (si tiene más de 1).
- **🃏 Charada Cubana** — numerología cubana.
- **🛒 Tienda** — estrategias públicas disponibles para solicitar.
- **❓ Ayuda** — información del plan actual.
- **📋 Cambiar plan** — solicitar cambio (solo usuarios no-owner).
- **⚙️ Administrar** — panel admin (solo owner).
- **🧪 Testing** — modo testing (solo owner).
- **🔮 Crear Adivinanza** — generar adivinanzas con IA (solo owner).

### Consultar Datos

Submenú para ver resultados reales de sorteos:

- **Fijo (P3)** / **Corrido (P4)** / **Ambos**: cada uno ofrece Hoy, Ayer, Esta Semana, Escoger Fecha.
- **Base de Datos**: enlaces directos a los PDFs oficiales de Florida Lottery.
- Los resultados de "Hoy" intentan primero el scraping web (Puppeteer) y caen al PDF si no está disponible.

### Icono de Estrategia en el Listado

Cada estrategia muestra un icono según la relación del usuario:
- 👤 Creada por el usuario actual
- 👥 Creada por otro usuario (no-owner)
- ✏️ Creada por el usuario y es dueño
- 📋 Viene del plan del usuario
- ➕ Asignada explícitamente (adquirida)

---

## 7. Motor de Estrategias Predictivas

### Arquitectura del Motor

Cada estrategia implementa la interfaz `StrategyDefinition`:

```typescript
interface StrategyDefinition {
  id: string;
  description: string;
  getContextMessage(label: string): string;
  buildContextKeyboard(menuId: string): InlineKeyboard;
  run(ctx: StrategyContext, map: DateDrawsMap): Promise<string>;
  getCandidates?(ctx: StrategyContext, map: DateDrawsMap): Promise<number[]>;
}
```

- `run()` genera el mensaje completo de resultado para Telegram.
- `getCandidates()` (opcional) retorna una lista de números candidatos (requerido para participar en el Consenso Multi-Estrategia y generar parlés).

### Contexto de Ejecución

Cada estrategia se ejecuta con un `StrategyContext`:
- `mapSource`: `"p3"` (Pick 3 / Fijo) o `"p4"` (Pick 4 / Corrido).
- `period`: `"m"` (Mediodía / Midday) o `"e"` (Noche / Evening).
- `params`: parámetros opcionales adicionales.

El usuario elige el contexto mediante un teclado de 4 botones:
- P3 (Fijos) ☀️ Mediodía
- P3 (Fijos) 🌙 Noche
- P4 (Corridos) ☀️ Mediodía
- P4 (Corridos) 🌙 Noche

### Números de 2 Dígitos

Todas las estrategias trabajan con números de 2 dígitos (00-99):
- **Pick 3** `[a, b, c]`: se extrae el número `b*10 + c` (los dos últimos dígitos, el "fijo").
- **Pick 4** `[a, b, c, d]`: se extraen dos pares `a*10 + b` y `c*10 + d` (los "corridos").

---

## 8. Catálogo Completo de Estrategias

### 8.1 Análisis de Frecuencia (`freq_analysis`)

**Método**: Conteo de frecuencia absoluta sobre todo el historial.

**Algoritmo**: Itera todos los sorteos una sola vez, cuenta apariciones de cada número 00-99. Calcula probabilidad % = conteo / total de ocurrencias. Registra la última fecha de aparición de cada número.

**Salida**: Top 20 números más frecuentes ("calientes") y Top 10 menos frecuentes ("fríos"), con conteo, probabilidad % y días desde la última aparición.

**Candidatos**: Top 20 por frecuencia (con conteo > 0).

---

### 8.2 Números Debidos — Gap (`gap_due`)

**Método**: Análisis de tiempo entre apariciones (inter-arrival time).

**Algoritmo**: Para cada número, recopila todas las fechas de aparición y calcula los intervalos entre apariciones consecutivas. Calcula el promedio de gaps (`avgGap`), el máximo histórico (`maxGap`) y el gap actual (`currentGap` = días desde la última aparición). El **factor de deuda** = `currentGap / avgGap`. Un factor > 1 indica que el número está "atrasado".

**Umbrales**: Mínimo 3 apariciones. Factor >= 2.0 (muy debido, rojo), >= 1.5 (naranja), >= 1.0 (amarillo).

**Salida**: Top 20 números ordenados por factor de deuda descendente.

**Candidatos**: Números con >= 3 apariciones y factor >= 1.0, top 20.

---

### 8.3 Patrón Calendario (`calendar_pattern`)

**Método**: Frecuencia condicional basada en calendario.

**Algoritmo**: Construye 4 mapas de frecuencia independientes:
- (A) Combinación día-de-la-semana × mes.
- (B) Día de la semana general.
- (C) Mes general.
- (D) Día del mes.

Para cada sorteo, incrementa contadores en las 4 dimensiones. Estima la próxima fecha de sorteo (última fecha + 1 día) y consulta los 4 mapas para ese contexto calendárico específico.

**Salida**: Cuatro secciones mostrando top 10 números por cada dimensión calendárica de la próxima fecha estimada.

**Candidatos**: Unión de top 10 de cada dimensión (deduplicados), máximo 20.

---

### 8.4 Seguidor de Secuencias — Markov Orden 1 (`transition_follow`)

**Método**: Cadena de Markov de primer orden.

**Algoritmo**: Construye una matriz de transición 100×100. Para cada par de sorteos consecutivos, registra cuántas veces el número Y apareció inmediatamente después de que apareció X. Dado el último sorteo, busca los sucesores más probables para cada número predecesor.

**Parámetros**: Top 8 sucesores por predecesor. El consenso interno requiere >= 2 votos de diferentes predecesores.

**Salida**: Para cada número del último sorteo, muestra top 8 sucesores históricos con conteo de transiciones y %. Una sección "CONSENSO" lista números votados por 2+ predecesores.

**Candidatos**: Combina top 8 sucesores de todos los números del último sorteo por conteo total de transiciones, retorna top 20.

---

### 8.5 Momentum de Tendencia (`trend_momentum`)

**Método**: Ratio de frecuencia reciente vs histórica.

**Algoritmo**: Cuenta apariciones en todo el historial y en los últimos 30 sorteos separadamente. `momentum = freqReciente / freqHistórica`. Momentum > 1.5 = en alza, < 0.5 = en baja.

**Parámetros**: Ventana reciente = 30 sorteos. Mínimo 3 apariciones históricas para alza, 5 para baja. Iconos: >= 3x (fuerte alza), >= 1.5x (alza), < 1x (baja).

**Salida**: Top 15 en alza y Top 10 en baja.

**Candidatos**: Números con >= 3 apariciones y momentum >= 1.0, top 20.

---

### 8.6 Análisis Posicional (`positional_analysis`)

**Método**: Frecuencia y gap por posición de dígito.

**Algoritmo para P3**: Descompone cada sorteo `[C, D, U]` en 3 flujos independientes de dígitos (centena, decena, unidad). Para cada posición: cuenta frecuencia de dígitos 0-9, calcula factor de deuda basado en gap, y añade pistas de calendario (top dígito por combinación día-semana + mes).

**Algoritmo para P4**: Divide `[A, B, C, D]` en Par1=AB y Par2=CD (00-99). Para cada slot de par: top 12 números por frecuencia + desglose por dígito (decenas/unidades) con factores de deuda.

**Candidatos para P3**: Toma top 5 dígitos por posición, genera producto cruzado de pares (centena×decena y decena×unidad), puntúa por producto de conteos, retorna top 20.

**Candidatos para P4**: Top 10 pares por slot fusionados por conteo, retorna top 20.

---

### 8.7 Más Salidores por Día de la Semana (`max_per_week_day`)

**Método**: Frecuencia agrupada por día de la semana.

**Algoritmo**: Para cada sorteo, determina el día de la semana e incrementa contadores por número por día. Extrae top 10 por día.

**Salida**: Tabla tipo dashboard con top 10 números por día en formato columnar `num(conteo)`.

**Candidatos**: Estima la fecha del próximo sorteo, retorna top 10 para ese día de la semana.

---

### 8.8 Estadísticas Individuales — Hot (`est_individuales`)

**Método**: Proximidad al máximo histórico de ausencia. Solo funciona para P3.

**Algoritmo**: Calcula para cada número 00-99 su gap máximo histórico y su gap actual. Un número es "caliente" cuando su gap actual está cerca del máximo (diferencia <= umbral configurable).

**Parámetros**: Umbral por defecto = 5 días de diferencia. Solo P3 (retorna aviso para P4).

**Candidatos**: Top 10 más calientes.

---

### 8.9 Markov Orden 2 (`markov_order2`)

**Método**: Cadena de Markov de segundo orden.

**Algoritmo**: Usa el estado compuesto `(penúltimo sorteo, último sorteo)` como predictor. Itera cronológicamente manteniendo ventanas de 3 sorteos. Para cada tripleta (N-2, N-1, N), registra transiciones `matrix[(a de N-2, b de N-1)] → c de N` para todas las combinaciones del producto cruzado.

**Parámetros**: Top 6 sucesores por par de estado. El consenso ordena por votos y luego por peso total.

**Salida**: Por par de estado: top 6 sucesores. Sección de consenso con números apoyados por múltiples pares.

**Candidatos**: Combina top 8 sucesores de todos los pares (a,b) de estado por conteo total, retorna top 20.

---

### 8.10 Récord de Ausencia Roto (`max_gap_breach`)

**Método**: Detección de récords de ausencia.

**Algoritmo**: Para cada número, calcula todos los gaps entre apariciones y encuentra el máximo histórico. `exceso = gapActual - maxGapHistórico`. Si exceso > 0, el número ha roto su récord de ausencia (nunca había tardado tanto). También calcula `% del récord = (gapActual / maxGapHistórico) * 100`.

**Parámetros**: Mínimo 3 apariciones. "Roto" = exceso > 0. "Acercándose" = % >= 80%.

**Salida**: Dos secciones — "RÉCORD ROTO" (por exceso) y "ACERCÁNDOSE AL RÉCORD" (por %).

**Candidatos**: Rotos (top 12 por exceso) + acercándose (top 8 por %), deduplicados, máximo 20.

---

### 8.11 Familias de Decenas (`decade_family`)

**Método**: Análisis en dos niveles — agrupa 100 números en 10 familias de decenas y luego analiza internamente.

**Algoritmo**: Agrupa en familias D0=00-09 hasta D9=90-99. Cuenta apariciones totales y recientes (últimos 30) por familia. Calcula momentum = freqReciente / freqHistórica. Rastrea gaps por familia para calcular factor de deuda. Para cada familia, ordena sus 10 números internos por conteo.

**Parámetros**: Ventana reciente = 30. Top 4 familias por momentum (>= 1.0) y top 3 por deuda (>= 1.0). Top 5 números internos por familia.

**Candidatos**: Top 5 números de las 4 familias más calientes + top 5 de las 3 más debidas, deduplicados, máximo 20.

---

### 8.12 Espejo y Complemento (`mirror_complement`)

**Método**: Análisis de correlación simétrica.

**Algoritmo**: Estudia probabilidades condicionales entre un número y sus variantes simétricas:
- **Espejo**: inversión de dígitos (47 ↔ 74).
- **Complemento a 99**: (23 ↔ 76).
- **Complemento a 100**: (23 ↔ 77).

Para cada aparición de un número fuente, verifica si su espejo/complemento aparece en los siguientes 1, 3 y 7 sorteos. Calcula tasas condicionales (`pct1`, `pct3`, `pct7`). Dado el último sorteo, puntúa los targets simétricos con fórmula ponderada: `score = pct1*3 + pct3*2 + pct7*1`.

**Parámetros**: Mínimo 3 apariciones. Ventanas de lookahead: 1, 3, 7 sorteos.

**Candidatos**: Scores de targets simétricos del último sorteo, top 20. Fallback: top por pct3 de todas las relaciones.

---

### 8.13 Análisis de Terminales (`terminal_analysis`)

**Método**: Análisis del dígito terminal (unidad, 0-9).

**Algoritmo**: Extrae el dígito de unidad de cada número sorteado. Rastrea por terminal: conteo total, conteo reciente (últimos 30), estadísticas de gap entre apariciones consecutivas (medido en sorteos, no días). Calcula momentum y factor de deuda por terminal. Dentro de cada terminal caliente/debido, lista los top 5 números 00-99 que comparten ese terminal.

**Parámetros**: Ventana reciente = 30. Score candidato: `momentum * 0.6 + min(dueFactor, 3) * 0.4`. Top 4 terminales para candidatos, 5 números cada uno.

**Candidatos**: Los top 4 terminales por score combinado, top 5 números de cada uno, máximo 20.

---

### 8.14 Detector de Ciclos (`cycle_detector`)

**Método**: Detección de ciclo dominante por análisis de bandas de gaps.

**Algoritmo**: Para cada número, calcula todos los gaps entre apariciones (en conteo de sorteos, no días). Agrupa gaps en bandas con tolerancia de ±20% alrededor de cada valor. La banda con más gaps es el ciclo dominante. Si concentra >= 22% de todos los gaps, se declara un ciclo. `fase = sorteosDesdÚltima / longitudCiclo`. Fase ~1.0 = en el punto del ciclo.

**Parámetros**: Mínimo 5 apariciones, tolerancia ±20%, concentración mínima 22%. Iconos: fase >= 1.2 (rojo, atrasado), 0.9-1.2 (verde, en ventana), 0.7-0.9 (amarillo, próximo).

**Candidatos**: Números con ciclo detectado y fase >= 0.8, top 20 por fase descendente.

---

### 8.15 Análisis de Rachas (`streak_analysis`)

**Método**: Análisis de presencia/ausencia consecutiva.

**Algoritmo**: Construye un array booleano de presencia por número para cada sorteo. Calcula:
- **Racha caliente**: sorteos consecutivos donde apareció (actual y máxima).
- **Racha fría**: sorteos consecutivos sin aparecer (actual, máxima, promedio histórico).
- **Factor de deuda fría**: rachaFríaActual / rachaFríaPromedio.
- **Ventanas recientes**: apariciones en últimos 7, 14, 30 sorteos.
- **Score caliente**: `rachaCalienteActual*3 + últimos7*2 + últimos14`.

**Parámetros**: Caliente si racha >= 2. Deuda fría umbral >= 1.5.

**Candidatos**: Mezcla de top 12 calientes + top 10 con deuda fría, deduplicados, máximo 20.

---

### 8.16 Score Bayesiano (`bayesian_score`)

**Método**: Combinación ponderada de 6 señales independientes normalizadas.

**Algoritmo**: Calcula 6 señales por número, normaliza cada una a 0-1 vía min-max, y combina con pesos fijos:

| Señal | Peso | Descripción |
|-------|------|-------------|
| S1 — Frecuencia | 15% | Ranking por conteo histórico total |
| S2 — Gap/Deuda | 20% | `min(gapActual / gapPromedio, 4)` |
| S3 — Momentum | 20% | `min(freqReciente / freqHistórica, 5)` con ventana de 30 |
| S4 — Fase de Ciclo | 15% | Fase del ciclo dominante (mismo método que cycle_detector), cap a 3 |
| S5 — Markov-1 | 20% | Probabilidad de transición desde números del último sorteo (máximo entre predecesores) |
| S6 — Racha Fría | 10% | `min(rachaFríaActual / rachaFríaPromedio, 4)` |

Score combinado = `(w1*S1 + w2*S2 + w3*S3 + w4*S4 + w5*S5 + w6*S6) * 100`

**Salida**: Top 20 números con score 0-100. Cada uno muestra un gráfico de barras por señal. Top 5 con desglose detallado.

**Candidatos**: Top 20 por score combinado.

---

### 8.17 Resonancia Fibonacci — 1-2-3 (`unodostres`)

**Método**: Modelo de resonancia temporal basado en la serie de Fibonacci.

**Algoritmo**: Para cada número, calcula `díasDesdÚltima` (desde la última fecha de datos, no hoy). La función de resonancia modela la probabilidad como suma de gaussianas centradas en intervalos Fibonacci:

`W(t) = Σ (F_n / F_max) * exp(-(t - F_n)² / (2σ²))`

donde F = {1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144} y σ = 3.5 días.

Score final: `0.1 + α * W(díasDesdÚltima) + β * (apariciones / maxApariciones)` con α=0.40, β=0.20.

**Fases**: Temprana (F1-F5), Expansión (F8-F21), Mayor (F34+) — las fases mayores tienen picos más significativos.

**Candidatos**: Números con apariciones > 0 y fibScore > 0.01, top 20 por score final.

---

### 8.18 Resonancia Fibonacci PLUS (`unodostres_plus`)

**Método**: Variante exacta del algoritmo de resonancia Fibonacci (1-2-3), con mejoras de UI/UX y límite dinámico.

**Diferencias con la estrategia original**:
- El menú contextual permite especificar si retornar un `Top 10`, `Top 20` o `Top 30` de candidatos.
- El formato de respuesta oculta el `Score` y `FibScore` para evitar disonancia cognitiva, presentando una interfaz visual extremadamente limpia.
- Agrupa de forma explícita los candidatos según la fase en que se encuentra el ciclo: 🔴 CICLO MAYOR, 🟡 EXPANSIÓN, 🟢 CORTO PLAZO.
- Identical al motor base en cuanto al score final por lo que respeta exactamente los mismos ganadores.

---

### 8.19 Consenso Multi-Estrategia (`consensus_multi`)

**Método**: Agregación por votación binaria.

**Algoritmo**: Flujo interactivo en varios pasos:
1. El usuario selecciona estrategias individual o por grupos predefinidos.
2. Se ejecutan en paralelo los `getCandidates()` de todas las estrategias seleccionadas.
3. Cada estrategia aporta 1 voto por cada número en su lista de candidatos.
4. Los números se ordenan por total de votos.

**Grupos Predefinidos**:

| Grupo | Nombre | Estrategias |
|-------|--------|-------------|
| A | Clásico Balanceado | freq_analysis, gap_due, calendar_pattern, transition_follow, positional_analysis |
| B | Señales Recientes | trend_momentum, markov_order2, decade_family, terminal_analysis, streak_analysis |
| C | Ruptura y Extremos | max_gap_breach, cycle_detector, mirror_complement, calendar_pattern |
| D | Meta + Complementos | bayesian_score, calendar_pattern, positional_analysis, decade_family, mirror_complement |

Los grupos están diseñados para evitar señales redundantes.

**Salida**: Tabla rankeada con conteo de votos, barra de % y estrategias que respaldan cada número.

---

### 8.19 Generador de Parlés (`parle`)

**No es una estrategia** sino una utilidad. Dado un array de números candidatos de cualquier estrategia, genera todas las combinaciones C(n,2) sin repetición.

**Parámetros**: Máximo 20 números de entrada (= 190 combinaciones).

**Salida**: Lista formateada de pares `XX => YY`.

---

### 8.20 Análisis Progresivo — Matriz (Back-Testing)

**Función exclusiva del owner**. Motor exhaustivo de back-testing convertido en Matriz de alta densidad.

**Algoritmo**:
1. El usuario define un rango de fechas y selecciona estrategias individuales o por grupos.
2. Para cada fecha del rango como punto de corte: construye el mapa filtrado hasta esa fecha, ejecuta getCandidates de todas las estrategias, evalúa de forma individual cada estrategia contra el resultado real del siguiente sorteo.
3. Se calcula el histórico de rendimiento. En lugar de generar combinatoria, genera una **Matriz Progresiva** (EST | HR% | AC | MX | ME | PICO | TND).
4. El sistema trackea métricas críticas de riesgo de ruina: 
   - `AC` (Actuales Fallos).
   - `MX` (Máximo Histórico de Fallos consecutivos).
   - `ME` (Media de fallos previos).

**Parámetros**: Máximo 2500 fechas, evalúa ilimitadas estrategias ya que eliminó la O(2^N) complejidad.

**Salida**: Tabla condensada de rendimiento que provee toma de decisión instantánea basada en el Riesgo vs Recompensa para elegir qué estrategia aplicar.

---

## 9. Estadísticas por Grupos (est_grupos)

Análisis del historial de P3 agrupando números por características:

- **Terminales (0-9)**: Dígito de unidad del número sorteado. Detecta qué terminal sale más, cuál está caliente.
- **Iniciales (0-9)**: Primer dígito del número. Revela qué prefijos dominan.
- **Dobles**: Números con dígitos repetidos (00, 11, 22... 99). Seguimiento de frecuencia y brecha.
- **Hot**: Un número/grupo se considera caliente cuando su brecha actual ≤ N días de diferencia con su máximo histórico de ausencia. N es configurable (1, 3, 5, 7, 10).

Permite elegir período (Mediodía o Noche) y ajustar el umbral de días de diferencia.

---

## 10. Charada Cubana

Sistema de numerología popular cubano integrado al bot. Mapea 100 números (00-99) a palabras clave y significados tradicionales.

**Funcionalidades**:
- **Catálogo paginado**: 5 páginas de 20 entradas cada una, navegables con botones Anterior/Siguiente.
- **Búsqueda**: por número exacto (00-99) o por texto (búsqueda parcial, insensible a acentos, mínimo 2 caracteres).

Accesible para todos los usuarios autorizados.

---

## 11. Crear Adivinanza (Solo Owner)

Funcionalidad exclusiva del dueño que usa **Google Gemini** para generar adivinanzas poéticas al estilo cubano a partir de números de lotería.

**Flujo**:
1. El owner puede ingresar números manualmente o usar los candidatos de una estrategia/consenso.
2. Se envía un prompt a Gemini con instrucciones de escribir 4-8 versos rimados en español cubano, sin revelar los números.
3. El resultado se muestra con botones para "Regenerar" (mismos números, nueva adivinanza) o volver.

**Modelos Gemini**: Auto-detecta el mejor modelo disponible (prefiere Flash por velocidad, fallback a Pro). El comando `/gemini_modelos` lista los modelos disponibles en la API key configurada.

---

## 12. Modo Testing (Solo Owner)

Permite al dueño establecer una **fecha de corte** para back-testing. Cuando está activo:

- Las estrategias solo usan datos hasta la fecha de corte (ignoran sorteos posteriores).
- Al ejecutar una estrategia, se muestra automáticamente un **bloque de verificación** comparando los candidatos predichos contra el resultado real del siguiente sorteo después del corte.
- Permite evaluar el rendimiento predictivo real de cada estrategia.

La fecha de corte se almacena en la pestaña "Testing" del Google Sheet (celda A2).

---

## 13. Variables de Entorno

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Sí | Token del bot de Telegram (BotFather) |
| `BOT_OWNER_ID` | Sí | ID(s) de Telegram del dueño (soporta múltiples separados por coma) |
| `WEBHOOK_URL` | En producción | URL pública del bot (ej: https://mi-bot.onrender.com) |
| `GOOGLE_SHEET_ID` | Recomendada | ID de la hoja de Google Sheets |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Recomendada | JSON de cuenta de servicio de Google en una línea |
| `GEMINI_API_KEY` | Para Adivinanzas | API key de Google AI Studio |
| `REQUEST_ACCESS_LINK` | Opcional | Enlace para solicitar acceso |
| `DISABLE_PUPPETEER` | Opcional | `true` para desactivar Puppeteer en local |
| `PORT` | Opcional | Puerto HTTP (default: 3000) |

---

## 14. Despliegue en Render

### Blueprint (`render.yaml`)

```yaml
services:
  - type: web
    name: power-ball-bot
    runtime: node
    buildCommand: npm install && npm run build
    startCommand: npm start
    envVars:
      - key: TELEGRAM_BOT_TOKEN (sync: false)
      - key: WEBHOOK_URL (sync: false)
      - key: BOT_OWNER_ID (sync: false)
      - key: GOOGLE_SHEET_ID
      - key: GOOGLE_SERVICE_ACCOUNT_JSON (sync: false)
      - key: GEMINI_API_KEY (sync: false)
      - key: REQUEST_ACCESS_LINK (sync: false)
```

### Proceso

1. Subir el código a GitHub.
2. Crear un Web Service en Render conectado al repositorio.
3. Configurar las variables de entorno.
4. El bot arranca con webhook (`WEBHOOK_URL/webhook`).
5. Health check disponible en GET `/` y `/health`.

---

## 15. Comandos del Bot

| Comando | Descripción | Acceso |
|---------|-------------|--------|
| `/start` | Iniciar y ver menú principal | Todos |
| `/help` | Ver ayuda personalizada por plan | Todos |
| `/cancel` | Cancelar operación actual y volver al menú | Todos |
| `/admin` | Abrir panel de administración | Solo owner |
| `/gemini_modelos` | Listar modelos Gemini disponibles | Solo owner |

---

## 16. Flujo de Datos de un Sorteo

1. **Descarga de PDF**: Al iniciar, el bot descarga los PDFs oficiales de P3 y P4 de Florida Lottery.
2. **Parseo**: Extrae texto de cada página del PDF usando pdfjs-dist, ordena items por posición Y/X, y aplica regex para extraer registros `MM/DD/YY [E|M] d-d-d (FB d)`.
3. **Mapa en memoria**: Construye `DateDrawsMap`: un objeto donde las claves son fechas `"MM/DD/YY"` y los valores son `{ m?: number[], e?: number[] }`.
4. **Caché**: El mapa se cachea indefinidamente en `cachedP3Map` / `cachedP4Map`.
5. **Estrategias**: Cada estrategia recibe el mapa completo (o filtrado si hay fecha de corte testing) y lo procesa con su algoritmo específico.

---

## 17. Formato de Fechas

Todo el sistema usa el formato **MM/DD/YY** (formato estándar de Florida Lottery). Ejemplos: `01/15/25` = 15 de enero de 2025, `12/31/24` = 31 de diciembre de 2024.

La zona horaria de referencia es siempre **America/New_York** (Florida).

---

## 18. Utilidades Compartidas de Estrategias (`utils.ts`)

- `mmddyyToDate()` / `dateToMMDDYY()`: Conversión de fechas.
- `sortDateKeys()`: Ordenamiento cronológico con transformación de Schwartz (un parseo por clave).
- `twoDigitNumbers(draw, mapSource)`: Extracción de números de 2 dígitos según tipo de juego.
- `validDateKeys()`: Filtra y ordena fechas que tengan sorteos válidos para un período/fuente dado.
- `filterMapByCutoff()`: Filtra mapa hasta una fecha de corte (testing).
- `getNextDrawResult()`: Encuentra el primer sorteo después de una fecha de corte (verificación).
- `buildTestingVerificationBlock()`: Compara candidatos predichos con resultados reales.

---

## 19. Resumen de Dependencias

| Paquete | Versión | Uso |
|---------|---------|-----|
| grammy | ^1.28.0 | Framework de bot de Telegram |
| google-spreadsheet | ^5.2.0 | Acceso a Google Sheets para persistencia |
| google-auth-library | ^10.6.1 | Autenticación con Google APIs |
| @google/generative-ai | ^0.24.1 | Google Gemini API para adivinanzas |
| pdfjs-dist | ^4.4.168 | Parseo de PDFs oficiales de Florida Lottery |
| puppeteer | ^24.15.0 | Scraping web de resultados del día |
| typescript | ^5.6.0 | Compilador TypeScript |
| tsx | ^4.19.0 | Ejecución TypeScript en desarrollo |

---

## 20. Motor de Auditoría Forense APEX

Sistema diseñado para garantizar **101% Integridad de Datos**. Verifica quirúrgicamente la DB contra la verdad absoluta de los PDFs oficiales de Florida Lottery.

**Funcionalidades**:
- **Descarga Resiliente**: Baja históricos en formato PDF con backoff exponencial.
- **Análisis Comparativo**: Examina toda la BD buscando:
  - **Faltantes**: Sorteos en el PDF que no están en la BD.
  - **Corruptos**: Sorteos donde los números extraídos difieren del PDF.
  - **Extras**: Sorteos locales capturados más rápido (vía scraping u oral) pero no presentes en PDF aún (generalmente el último sorteo de hoy).
- **Reparación Autónoma**: Dispara peticiones `UPSERT` seguras corrigiendo y forzando la sincronización de cualquier falla encontrada.
- **Integración UI**: Botón en panel `/admin` con dashboard indicando las fallas precisas y el botón `🛠️ Reparar Automáticamente`.

---

## 21. Principios de Rendimiento del Código

El proyecto sigue reglas estrictas de rendimiento documentadas en `.cursor/rules/performance.mdc`:

1. **Paralelizar siempre que sea posible**: usar `Promise.all` para operaciones async independientes.
2. **Iterar una sola vez**: evitar múltiples pasadas sobre la misma colección.
3. **Lookups O(1)**: usar Map/Set en lugar de array.find/includes en rutas críticas.
4. **Filtrar temprano**: reducir datos antes de procesarlos.
5. **Caché con TTL**: para cómputos que se repiten con los mismos inputs.
6. **Estrategias en paralelo**: siempre ejecutar múltiples getCandidates con Promise.all.
7. **Minimizar round-trips a Telegram API**: preferir editMessageText sobre delete + reply.
