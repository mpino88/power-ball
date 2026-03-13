# Protocolo BLISS: Reglas de Integridad y Dispatcher

## Contexto
Este proyecto utiliza un despachador centralizado en `bot.ts` para gestionar callbacks de diferentes módulos (`security`, `strategies`, etc.). La modularización es necesaria para la Escala 101%, pero introduce el riesgo de "Disonancia de Despacho" si no se sincronizan los prefijos.

## REGLAS INVIOLABLES

1. **Dispatcher Sync (Sincronización de Despacho):**
    - Por cada nuevo prefijo de `callback_query` (ej: `nuevo_prefijo_*`) añadido en `callbacks.ts` o cualquier manejador secundario, DEBES actualizar la condición de filtrado en el dispatcher de `bot.ts` (línea ~1195 o similar).
    - **NUNCA** asumas que el despachador detectará automáticamente nuevos patrones. El registro explícito es obligatorio.

2. **Principio de No Regresión UI:**
    - Antes de modificar un flujo existente (ej: Tienda), verifica todos sus estados ("Volver", "Confirmar", "Cancelar").
    - Si transformas un paso directo en uno multi-etapa, rastrea el `callback_data` de cada botón nuevo y asegúrate de que el dispatcher los reconozca.

3. **Notificación de Acción Crítica:**
    - Toda solicitud de compra o cambio de plan debe notificar proactivamente al administrador vía `ctx.api.sendMessage(adminId, ...)`.
    - No dependas de que el administrador revise periódicamente; el monopolio requiere velocidad de respuesta.

4. **Persistencia Sheet-First:**
    - Siempre que se acceda a un menú que dependa de estados de usuario (Planes, Estrategias Asignadas), se debe invocar `reloadConfigFromStorage()` o similar para evitar datos en caché desfasados.

5. **Backtesting Atómico (N >= 1):**
    - No restrinjas el análisis a combinaciones múltiples. El backtesting individual es la base de la auditoría forense.

---
*Mandato APEX - Protocolo Bliss*
