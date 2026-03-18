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
  buildConsultarDatosKeyboard,
  buildSugerenciaKeyboard,
  buildAdminSugerenciaListKeyboard,
  buildAdminUserSugerenciaKeyboard,
  buildMySugerenciasKeyboard,
  ESTRATEGIAS_OPEN_CALLBACK,
  CONSULTAR_DATOS_CALLBACK,
  buildMainMenuMessage,
} from "./keyboards.js";
export type { MainKeyboardDeps } from "./keyboards.js";
export { handleMenuCallback } from "./handlers.js";
export type { MenuHandlersDeps } from "./handlers.js";
