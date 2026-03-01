/**
 * Módulo Seguridad: restricción de acceso, panel de administración, usuarios y menús.
 */

export { createRestrictMiddleware } from "./middleware.js";
export type { RestrictMiddlewareOptions, BuildMainKeyboard } from "./middleware.js";
export { handleSecurityCallback } from "./callbacks.js";
export type { SecurityCallbackDeps } from "./callbacks.js";
export { handleSecurityMessage } from "./messageHandler.js";
export type { SecurityMessageDeps } from "./messageHandler.js";
export {
  buildSecurityKeyboard,
  buildManageMenusKeyboard,
  buildUserMenusKeyboard,
  formatUserLine,
} from "./keyboards.js";
export {
  addingUserFlow,
  creatingMenuFlow,
  editingMenuFlow,
  deletingMenuFlow,
  clearAllFlows,
} from "./flows.js";
export type { AddingStep, CreatingStep } from "./flows.js";
export { labelToMenuId } from "./menuIdFromLabel.js";
