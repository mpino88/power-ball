# Motor de estrategias

Cada estrategia se asocia al motor por **strategy_id** (ej. `max_per_week_day`) y tiene su propia implementación en un archivo.

## Estructura

- **`types.ts`** — Tipos compartidos: `StrategyDefinition`, `StrategyContext`, `DateDrawsMap`, parseo de callbacks `strat_*`.
- **`context-menu.ts`** — Menú por defecto (base P3/P4 + período Mediodía/Noche). Reutilizable por estrategias que usen el mismo esquema.
- **`index.ts`** — Motor: registro `Map<id, StrategyDefinition>`, `registerStrategy()`, `runStrategy()`, `buildStrategyContextKeyboard()`, `getStrategyContextMessage()`. Al final se registran todas las estrategias.
- **`estrategia-<nombre>.ts`** — Un archivo por estrategia: lógica de la base de conocimientos, menú contextual y resolución.

## Añadir una nueva estrategia

1. Crear **`estrategia-<nombre>.ts`** en esta carpeta.
2. Implementar e exportar un objeto que cumpla **`StrategyDefinition`**:
   - `id`: string (ej. `"mi_estrategia"`).
   - `getContextMessage(menuLabel)`: mensaje al abrir la estrategia.
   - `buildContextKeyboard(menuId)`: teclado (puedes usar `buildDefaultContextKeyboard(menuId)` si usas P3/P4 + M/E).
   - `run(context, map)`: recibe el mapa ya cargado según `context.mapSource`; devuelve el texto a enviar.
3. En **`index.ts`**, importar la estrategia y llamar **`registerStrategy(miEstrategia)`**.

El bot ya usa el motor: al pulsar un menú con ese `id` se muestra el menú contextual; al elegir opción se ejecuta `runStrategy(id, context, deps)`.
