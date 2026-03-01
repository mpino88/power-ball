/**
 * Módulo Seguridad: restricción de acceso, panel de administración, usuarios y menús.
 */

export { createRestrictMiddleware } from "./middleware.js";
export type { RestrictMiddlewareOptions, BuildMainKeyboard } from "./middleware.js";
export { handleSecurityCallback, handleEstrategiasUserCallback } from "./callbacks.js";
export type { SecurityCallbackDeps, EstrategiasUserCallbackDeps } from "./callbacks.js";
export { handleSecurityMessage } from "./messageHandler.js";
export type { SecurityMessageDeps } from "./messageHandler.js";
export {
  buildSecurityKeyboard,
  buildManageEstrategiasKeyboard,
  buildManageEstrategiasKeyboardUser,
  buildManagePlansKeyboard,
  buildUserMenusKeyboard,
  formatUserLine,
} from "./keyboards.js";
export {
  addingUserFlow,
  creatingMenuFlow,
  editingMenuFlow,
  deletingMenuFlow,
  creatingPlanFlow,
  editingPlanFlow,
  clearAllFlows,
} from "./flows.js";
export type { AddingStep, CreatingStep } from "./flows.js";
export { labelToMenuId } from "./menuIdFromLabel.js";
