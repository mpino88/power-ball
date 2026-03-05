/**
 * Módulo Menús: teclados principales y contextuales, handlers de callbacks (juego, estadísticas, ayuda).
 */

export type { GameMenu } from "./types.js";
export {
  buildMainKeyboard,
  buildEstrategiasKeyboard,
  buildSubmenuKeyboard,
  buildEstadisticasKeyboard,
  buildIndividualPeriodKeyboard,
  buildDiasDiferenciaKeyboard,
  buildDiasDiferenciaKeyboardIndividual,
  buildTestingKeyboard,
  buildTestingMessage,
  ESTRATEGIAS_OPEN_CALLBACK,
} from "./keyboards.js";
export type { MainKeyboardDeps } from "./keyboards.js";
export { handleMenuCallback } from "./handlers.js";
export type { MenuHandlersDeps } from "./handlers.js";
