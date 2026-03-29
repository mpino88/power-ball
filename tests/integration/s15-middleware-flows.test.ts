/**
 * S-15: Middleware Flow Tests — Nivel 3-4
 *
 * Instancia createRestrictMiddleware() real con:
 *   - Repositorio (setPending/getPending/deletePending) MOCKEADO → controlamos estado
 *   - user-config, plans, payment-methods MOCKEADOS → sin DB
 *   - ctx Grammy MOCKEADO → sin Telegram
 *
 * Por qué no withRollback aquí:
 *   El middleware usa getDbPool() (pool global). withRollback usa un client
 *   aislado en transacción. Son conexiones distintas — no se ven entre sí.
 *   S-16 ya cubre la capa SQL. S-15 cubre la lógica de flujo del middleware.
 *
 * Cobertura:
 *   - plan_request:  click → setPending → phone → activar/solicitar/cancelar
 *   - plan_renewal:  expired → click → setPending → phone → activar/cancelar
 *   - BUG-1: deletePending swallows error → flujo continúa, pending huérfano
 *   - BUG-2: race condition doble-tap documentado
 *   - Owner bypass, usuario sin pending, aislamiento entre usuarios
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks de nivel módulo (hoisted por Vitest) ───────────────────────────────
// CRÍTICO: vi.mock se hoist al top del archivo. No usar dentro de beforeAll/beforeEach.

// Estado compartido del repositorio mock — controlamos qué retorna getPending
let _mockPendingStore: Map<string, { planId: string; planName: string; temporality: string } | null> = new Map();
const _setPendingCalls: Array<[number, string, object]> = [];
const _deletePendingCalls: Array<[number, string]> = [];
let _deleteShouldFail = false;

vi.mock("../../src/infrastructure/database/PostgresPendingInteractionRepository.js", () => ({
  setPendingInteraction: vi.fn(async (userId: number, type: string, data: object) => {
    _setPendingCalls.push([userId, type, data]);
    _mockPendingStore.set(`${userId}:${type}`, data as any);
  }),
  getPendingInteraction: vi.fn(async (userId: number, type: string) => {
    return _mockPendingStore.get(`${userId}:${type}`) ?? null;
  }),
  deletePendingInteraction: vi.fn(async (userId: number, type: string) => {
    if (_deleteShouldFail) throw new Error("DB failure simulated"); // FIX-1: re-lanza
    const key = `${userId}:${type}`;
    const existed = _mockPendingStore.has(key); // FIX-2: atomicidad via boolean
    _mockPendingStore.delete(key);
    if (existed) _deletePendingCalls.push([userId, type]);
    return existed;
  }),
  cleanExpiredPendingInteractions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/user-config.js", () => ({
  addPlanRequest:       vi.fn().mockResolvedValue(undefined),
  requestPlanRenewal:   vi.fn().mockResolvedValue(undefined),
  assignPlanToUser:     vi.fn().mockResolvedValue(undefined),
  getPlanTemporality:   vi.fn().mockReturnValue(null),
  hasUsedTrial:         vi.fn().mockResolvedValue(false),
  isPlanExpired:        vi.fn().mockReturnValue(false),
  refreshIfStale:       vi.fn().mockResolvedValue(undefined),
  saveLead:             vi.fn().mockResolvedValue(undefined),
  getOwnerIds:          vi.fn().mockReturnValue([]),
  isRegistered:         vi.fn().mockReturnValue(false),
  getUsername:          vi.fn().mockReturnValue(null),
  getPhone:             vi.fn().mockReturnValue(null),
  saveUserContact:      vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/plans.js", () => ({
  getPlans: vi.fn().mockReturnValue([
    {
      id: "basico",
      title: "Plan Básico",
      description: "Acceso completo a estrategias y picks.",
      autoApprove: false,
      menuIds: ["menu_basico"],
      price_7d: null, price_1m: "$49", price_3m: "$99", price_12m: "$299",
    },
  ]),
  getPriceForTemporality: vi.fn().mockReturnValue("$49"),
  formatPlanPrice:        vi.fn().mockReturnValue("$49"),
  REGULAR_TEMPORALITIES:  [{ id: "1m", label: "1 Mes" }, { id: "3m", label: "3 Meses" }],
  TEMPORALITIES:          [{ id: "7d", label: "7 Días" }, { id: "1m", label: "1 Mes" }, { id: "3m", label: "3 Meses" }],
}));

vi.mock("../../src/payment-methods.js", () => ({
  getPaymentMethods:        vi.fn().mockReturnValue([]),
  loadPaymentMethodsFromDB: vi.fn().mockResolvedValue(undefined),
}));

// ─── Import real del middleware (después de los mocks) ────────────────────────
import { createRestrictMiddleware } from "../../src/security/middleware.js";
import type { addPlanRequest, assignPlanToUser, hasUsedTrial, isPlanExpired } from "../../src/user-config.js";

// Alias tipados para los mocks
const userConfig = await import("../../src/user-config.js");
const mockAssignPlan       = userConfig.assignPlanToUser   as ReturnType<typeof vi.fn>;
const mockAddPlanReq       = userConfig.addPlanRequest     as ReturnType<typeof vi.fn>;
const mockRequestRenewal   = userConfig.requestPlanRenewal as ReturnType<typeof vi.fn>;
const mockHasUsedTrial     = userConfig.hasUsedTrial       as ReturnType<typeof vi.fn>;
const mockIsPlanExpired    = userConfig.isPlanExpired      as ReturnType<typeof vi.fn>;
const mockIsRegistered     = userConfig.isRegistered       as ReturnType<typeof vi.fn>;

const UID  = 100001;
const UID2 = 100002;

// ─── helpers ──────────────────────────────────────────────────────────────────

type MockCtx = {
  from: { id: number; first_name: string; last_name?: string };
  message?: {
    text?: string;
    contact?: { phone_number: string; first_name?: string; last_name?: string };
  };
  callbackQuery?: { data?: string };
  answerCallbackQuery: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
};

function ctx(userId: number, overrides: Partial<MockCtx> = {}): MockCtx {
  return {
    from: { id: userId, first_name: "Test" },
    message: undefined,
    callbackQuery: undefined,
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
    ...overrides,
  };
}

function makeMW(opts: {
  isAllowed?: boolean;
  isOwner?: boolean;
  isPlanExpired?: boolean;
  hasUsedTrial?: boolean;
} = {}) {
  mockIsPlanExpired.mockReturnValue(opts.isPlanExpired ?? false);
  mockHasUsedTrial.mockResolvedValue(opts.hasUsedTrial ?? false);

  return createRestrictMiddleware({
    getOwnerId:        () => 999,
    isAllowed:         () => opts.isAllowed ?? false,
    isOwner:           () => opts.isOwner ?? false,
    requestAccessLink: "https://t.me/blisstest",
    buildMainKeyboard: () => ({ inline_keyboard: [] } as any),
    addPlanRequest:    userConfig.addPlanRequest as any,
    reloadPlans:       vi.fn().mockResolvedValue(undefined),
  });
}

function setPendingFor(userId: number, type: "plan_request" | "plan_renewal", overrides: Partial<{planId:string;planName:string;temporality:string}> = {}) {
  _mockPendingStore.set(`${userId}:${type}`, {
    planId:      overrides.planId      ?? "basico",
    planName:    overrides.planName    ?? "Plan Básico",
    temporality: overrides.temporality ?? "7d",
  });
}

function hasPendingFor(userId: number, type: string): boolean {
  return _mockPendingStore.has(`${userId}:${type}`);
}

// ─── S-15 tests ───────────────────────────────────────────────────────────────

describe("S-15: Middleware Flows (Nivel 3-4)", () => {

  beforeEach(async () => {
    // resetAllMocks limpia calls Y reimplementaciones de tests anteriores
    vi.resetAllMocks();
    _mockPendingStore.clear();
    _setPendingCalls.length = 0;
    _deletePendingCalls.length = 0;
    _deleteShouldFail = false;

    // Re-aplicar implementaciones por defecto del repositorio (resetAllMocks las borra)
    const repo = await import("../../src/infrastructure/database/PostgresPendingInteractionRepository.js");
    (repo.setPendingInteraction as ReturnType<typeof vi.fn>).mockImplementation(
      async (userId: number, type: string, data: object) => {
        _setPendingCalls.push([userId, type, data]);
        _mockPendingStore.set(`${userId}:${type}`, data as any);
      }
    );
    (repo.getPendingInteraction as ReturnType<typeof vi.fn>).mockImplementation(
      async (userId: number, type: string) => _mockPendingStore.get(`${userId}:${type}`) ?? null
    );
    (repo.deletePendingInteraction as ReturnType<typeof vi.fn>).mockImplementation(
      async (userId: number, type: string) => {
        if (_deleteShouldFail) throw new Error("DB failure simulated");
        const key = `${userId}:${type}`;
        const existed = _mockPendingStore.has(key);
        _mockPendingStore.delete(key);
        if (existed) _deletePendingCalls.push([userId, type]);
        return existed;
      }
    );

    // Re-aplicar defaults de user-config
    const uc = await import("../../src/user-config.js");
    (uc.addPlanRequest       as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (uc.requestPlanRenewal   as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (uc.assignPlanToUser     as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (uc.hasUsedTrial         as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (uc.isPlanExpired        as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (uc.refreshIfStale       as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (uc.saveLead             as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (uc.getOwnerIds          as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (uc.isRegistered         as ReturnType<typeof vi.fn>).mockReturnValue(false);
    (uc.getUsername          as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (uc.getPhone             as ReturnType<typeof vi.fn>).mockReturnValue(null);

    // Re-aplicar defaults de plans y payment-methods
    const plans = await import("../../src/plans.js");
    (plans.getPlans as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "basico", title: "Plan Básico", description: "Acceso completo a estrategias y picks.",
        autoApprove: false, menuIds: ["menu_basico"],
        price_7d: null, price_1m: "$49", price_3m: "$99", price_12m: "$299" },
    ]);
    (plans.getPriceForTemporality as ReturnType<typeof vi.fn>).mockReturnValue("$49");
    (plans.formatPlanPrice        as ReturnType<typeof vi.fn>).mockReturnValue("$49");

    const pm = await import("../../src/payment-methods.js");
    (pm.getPaymentMethods        as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (pm.loadPaymentMethodsFromDB as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  // ── Owner bypass ─────────────────────────────────────────────────────────────

  it("owner: siempre llama next(), sin reply ni DB", async () => {
    const mw   = makeMW({ isOwner: true });
    const c    = ctx(UID, { message: { text: "/start" } });
    const next = vi.fn().mockResolvedValue(undefined);

    await mw(c as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(c.reply).not.toHaveBeenCalled();
    expect(_setPendingCalls).toHaveLength(0);
  });

  it("uid undefined: llama next() sin error", async () => {
    const mw = makeMW();
    const c  = { from: undefined, message: { text: "x" }, reply: vi.fn() } as any;
    const next = vi.fn().mockResolvedValue(undefined);
    await expect(mw(c, next)).resolves.not.toThrow();
    expect(next).toHaveBeenCalledOnce();
  });

  // ── plan_request: click en botón de plan ─────────────────────────────────────

  it("plan_request: 'request_plan_basico_7d' → llama setPendingInteraction con datos correctos", async () => {
    const mw   = makeMW({ isAllowed: false });
    const c    = ctx(UID, {
      callbackQuery: { data: "request_plan_basico_7d" },
    });
    const next = vi.fn();

    await mw(c as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(_setPendingCalls).toHaveLength(1);
    const [userId, type, data] = _setPendingCalls[0]!;
    expect(userId).toBe(UID);
    expect(type).toBe("plan_request");
    expect(data).toMatchObject({ planId: "basico", planName: "Plan Básico", temporality: "7d" });

    // Reply incluye instrucción de compartir teléfono
    const text: string = c.reply.mock.calls[0][0];
    expect(text).toContain("número de contacto");
    expect(text).toContain("Plan Básico");
  });

  it("plan_request: 'request_plan_basico_1m' → setPending con temporality=1m", async () => {
    const mw = makeMW({ isAllowed: false });
    const c  = ctx(UID, { callbackQuery: { data: "request_plan_basico_1m" } });
    await mw(c as any, vi.fn());

    const [, , data] = _setPendingCalls[0]!;
    expect((data as any).temporality).toBe("1m");
  });

  // ── plan_request: recepción del teléfono ─────────────────────────────────────

  it("plan_request trial (7d): teléfono recibido → assignPlanToUser + pending borrado", async () => {
    setPendingFor(UID, "plan_request", { temporality: "7d" });
    const mw   = makeMW({ isAllowed: false });
    const c    = ctx(UID, {
      message: { contact: { phone_number: "+15559876543", first_name: "Test", last_name: "User" } },
    });
    await mw(c as any, vi.fn());

    expect(mockAssignPlan).toHaveBeenCalledOnce();
    expect(mockAssignPlan).toHaveBeenCalledWith(
      UID, "Plan Básico", ["menu_basico"], "7d", "Test User", "+15559876543"
    );
    expect(hasPendingFor(UID, "plan_request")).toBe(false);

    const replyText: string = c.reply.mock.calls[0][0];
    expect(replyText).toContain("activado");
  });

  it("plan_request pago (1m): teléfono recibido → requestPlanRenewal (NO assignPlan) + pending borrado", async () => {
    // processPlanSubmission usa requestPlanRenewal para ambos tipos (plan_requested + renewal_requested)
    setPendingFor(UID, "plan_request", { temporality: "1m" });
    const mw = makeMW({ isAllowed: false });
    const c  = ctx(UID, {
      message: { contact: { phone_number: "+15551234567", first_name: "Bliss" } },
    });
    await mw(c as any, vi.fn());

    expect(mockAssignPlan).not.toHaveBeenCalled();
    expect(mockRequestRenewal).toHaveBeenCalledOnce();
    expect(hasPendingFor(UID, "plan_request")).toBe(false);

    const replyText: string = c.reply.mock.calls[0][0];
    expect(replyText).toContain("Solicitud registrada");
  });

  it("plan_request: '❌ Cancelar' → deletePending + reply cancelada", async () => {
    setPendingFor(UID, "plan_request");
    const mw = makeMW({ isAllowed: false });
    const c  = ctx(UID, { message: { text: "❌ Cancelar" } });
    await mw(c as any, vi.fn());

    expect(hasPendingFor(UID, "plan_request")).toBe(false);
    expect(c.reply.mock.calls[0][0]).toContain("cancelada");
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it("plan_request: texto random con pending activo → re-pide teléfono, NO cancela pending", async () => {
    setPendingFor(UID, "plan_request");
    const mw = makeMW({ isAllowed: false });
    const c  = ctx(UID, { message: { text: "hola que tal" } });
    await mw(c as any, vi.fn());

    // Pending sigue activo
    expect(hasPendingFor(UID, "plan_request")).toBe(true);
    const text: string = c.reply.mock.calls[0][0];
    expect(text).toContain("botón de abajo");
    expect(mockAssignPlan).not.toHaveBeenCalled();
  });

  it("plan_request trial ya usado: bloquea y NO escribe pending", async () => {
    const mw = makeMW({ isAllowed: false, hasUsedTrial: true });
    const c  = ctx(UID, { callbackQuery: { data: "request_plan_basico_7d" } });
    await mw(c as any, vi.fn());

    expect(_setPendingCalls).toHaveLength(0);
    const text: string = c.reply.mock.calls[0][0];
    expect(text).toContain("Ya usaste tu acceso de prueba");
  });

  // ── plan_renewal flow ─────────────────────────────────────────────────────────

  it("plan_renewal: 'renew_plan_basico_7d' con trial disponible → setPending + reply contacto", async () => {
    const mw = makeMW({ isAllowed: true, isPlanExpired: true, hasUsedTrial: false });
    const c  = ctx(UID, { callbackQuery: { data: "renew_plan_basico_7d" } });
    await mw(c as any, vi.fn());

    expect(_setPendingCalls).toHaveLength(1);
    const [, type] = _setPendingCalls[0]!;
    expect(type).toBe("plan_renewal");

    const text: string = c.reply.mock.calls[0][0];
    expect(text).toContain("Renovar plan");
  });

  it("plan_renewal: 'renew_plan_basico_1m' → setPending type=plan_renewal, temporality=1m", async () => {
    const mw = makeMW({ isAllowed: true, isPlanExpired: true });
    const c  = ctx(UID, { callbackQuery: { data: "renew_plan_basico_1m" } });
    await mw(c as any, vi.fn());

    const [, type, data] = _setPendingCalls[0]!;
    expect(type).toBe("plan_renewal");
    expect((data as any).temporality).toBe("1m");
  });

  it("plan_renewal: trial ya usado → bloquea y NO escribe pending", async () => {
    const mw = makeMW({ isAllowed: true, isPlanExpired: true, hasUsedTrial: true });
    const c  = ctx(UID, { callbackQuery: { data: "renew_plan_basico_7d" } });
    await mw(c as any, vi.fn());

    expect(_setPendingCalls).toHaveLength(0);
    const text: string = c.reply.mock.calls[0][0];
    expect(text).toContain("Ya usaste tu acceso de prueba");
  });

  it("plan_renewal: '❌ Cancelar' → deletePending + reply cancelada", async () => {
    setPendingFor(UID, "plan_renewal", { temporality: "1m" });
    const mw = makeMW({ isAllowed: true, isPlanExpired: true });
    const c  = ctx(UID, { message: { text: "❌ Cancelar" } });
    await mw(c as any, vi.fn());

    expect(hasPendingFor(UID, "plan_renewal")).toBe(false);
    expect(c.reply.mock.calls[0][0]).toContain("cancelada");
  });

  it("plan_renewal: teléfono para 7d → assignPlanToUser + pending borrado", async () => {
    setPendingFor(UID, "plan_renewal", { temporality: "7d" });
    const mw = makeMW({ isAllowed: true, isPlanExpired: true });
    const c  = ctx(UID, {
      message: { contact: { phone_number: "+15550001111", first_name: "Bliss" } },
    });
    await mw(c as any, vi.fn());

    expect(mockAssignPlan).toHaveBeenCalledOnce();
    expect(hasPendingFor(UID, "plan_renewal")).toBe(false);
    expect(c.reply.mock.calls[0][0]).toContain("activado");
  });

  it("plan_renewal: teléfono para 1m → requestPlanRenewal (NO assignPlan) + pending borrado", async () => {
    setPendingFor(UID, "plan_renewal", { temporality: "1m" });
    const mw = makeMW({ isAllowed: true, isPlanExpired: true });
    const c  = ctx(UID, {
      message: { contact: { phone_number: "+15551110000", first_name: "Test" } },
    });
    await mw(c as any, vi.fn());

    expect(mockAssignPlan).not.toHaveBeenCalled();
    expect(hasPendingFor(UID, "plan_renewal")).toBe(false);
    const text: string = c.reply.mock.calls[0][0];
    expect(text).toContain("renovación registrada");
  });

  // ── FIX-1: delete re-lanza el error → middleware NO activa el plan ──────────

  it("FIX-1: delete falla (throw) → assignPlanToUser NO se llama, reply de error", async () => {
    /**
     * FIXED: deletePendingInteraction ahora re-lanza el error.
     * Si la DB falla en DELETE, el middleware captura la excepción en su
     * try/catch existente y responde "No se pudo guardar la solicitud".
     * El plan NO se activa. El pending queda en DB para reintento.
     */
    _deleteShouldFail = true;
    setPendingFor(UID, "plan_request", { temporality: "7d" });

    const mw = makeMW({ isAllowed: false });
    const c  = ctx(UID, {
      message: { contact: { phone_number: "+15551234567", first_name: "Test" } },
    });
    await mw(c as any, vi.fn());

    // El plan NO se activó — el error fue capturado antes de llegar a assignPlanToUser
    expect(mockAssignPlan).not.toHaveBeenCalled();

    // El pending sigue en store (DB falla = no se borró)
    expect(hasPendingFor(UID, "plan_request")).toBe(true);

    // El middleware respondió con el mensaje de error
    expect(c.reply).toHaveBeenCalled();
    const text: string = c.reply.mock.calls[0][0];
    expect(text).toContain("No se pudo");
  });

  // ── FIX-2: DELETE...RETURNING atómico — doble-tap activa el plan solo 1 vez ─

  it("FIX-2: doble-tap — DELETE...RETURNING garantiza que solo una request activa el plan", async () => {
    /**
     * FIXED: deletePendingInteraction retorna boolean (DELETE...RETURNING).
     * La primera request en llegar borra el pending (retorna true) y activa el plan.
     * La segunda request intenta borrar pero retorna false → middleware hace return.
     *
     * En el mock: la primera llamada a delete borra el entry del store y retorna true.
     * La segunda encuentra el store vacío y retorna false → middleware aborta.
     */
    setPendingFor(UID, "plan_request", { temporality: "7d" });

    const mw = makeMW({ isAllowed: false });
    const contact = { phone_number: "+15559998888", first_name: "Double" };
    const ctxA = ctx(UID, { message: { contact } });
    const ctxB = ctx(UID, { message: { contact } });

    await Promise.all([
      mw(ctxA as any, vi.fn()),
      mw(ctxB as any, vi.fn()),
    ]);

    // Solo una de las dos requests activó el plan — atomicidad garantizada
    expect(mockAssignPlan).toHaveBeenCalledOnce();
  });

  // ── Aislamiento entre usuarios ────────────────────────────────────────────────

  it("pending de UID no interfiere con flujo de UID2", async () => {
    setPendingFor(UID, "plan_request");
    // UID2 no tiene pending

    const mw = makeMW({ isAllowed: false });
    // UID2 envía texto random — no debe tocar el pending de UID
    const c2   = ctx(UID2, { message: { text: "hola" } });
    const next = vi.fn();
    await mw(c2 as any, next);

    // Pending de UID intacto
    expect(hasPendingFor(UID, "plan_request")).toBe(true);
  });

  it("UID y UID2 pueden tener pending independientes simultáneos", async () => {
    setPendingFor(UID,  "plan_request", { temporality: "7d" });
    setPendingFor(UID2, "plan_renewal", { temporality: "1m" });

    const mwUID  = makeMW({ isAllowed: false });
    const mwUID2 = makeMW({ isAllowed: true, isPlanExpired: true });

    const cUID  = ctx(UID,  { message: { contact: { phone_number: "+1555001", first_name: "A" } } });
    const cUID2 = ctx(UID2, { message: { text: "❌ Cancelar" } });

    await Promise.all([
      mwUID(cUID   as any, vi.fn()),
      mwUID2(cUID2 as any, vi.fn()),
    ]);

    // UID: trial activado
    expect(mockAssignPlan).toHaveBeenCalledWith(UID, "Plan Básico", ["menu_basico"], "7d", "A", "+1555001");
    // UID2: cancelado
    expect(hasPendingFor(UID2, "plan_renewal")).toBe(false);
  });

  // ── Sincronización de estado: plan activo no llega al bloque de pending ──────

  it("usuario autorizado con plan vigente llama next() sin tocar pending", async () => {
    setPendingFor(UID, "plan_request"); // pending en store pero no debe ejecutarse
    const mw   = makeMW({ isAllowed: true, isPlanExpired: false });
    const c    = ctx(UID, { message: { text: "/menu" } });
    const next = vi.fn().mockResolvedValue(undefined);

    await mw(c as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(mockAssignPlan).not.toHaveBeenCalled();
    // El pending no fue procesado porque el usuario tiene acceso vigente
  });
});
