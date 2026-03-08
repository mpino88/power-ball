/**
 * Script de seed one-shot: registra la estrategia "unodostres" en el catálogo
 * (Sheet o archivo) y la asigna a todos los dueños del bot.
 *
 * Uso:
 *   npx tsx scripts/seed-unodostres.ts
 *
 * Requiere las mismas variables de entorno que el bot:
 *   BOT_OWNER_ID, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON (o EMAIL+KEY).
 */

import {
  initUserConfig,
  loadStrategiesFromSheet,
  saveStrategiesToSheet,
  getOwnerIds,
  getUserAssignedMenuIds,
  addAllowed,
  setExtraMenus,
  getStorageBackend,
} from "../src/user-config.js";

import {
  initCustomMenusFromSheet,
  setStrategySheetPersist,
  seedCustomMenus,
} from "../src/custom-menus.js";

// ── Entrada a insertar ────────────────────────────────────────────────────────

const ENTRY = {
  id: "unodostres",
  label: "Resonancia Fibonacci (1-2-3)",
  description:
    "Proyecta ventanas de alta probabilidad usando la serie Fibonacci como estructura temporal. " +
    "Un número está en resonancia si lleva exactamente F_n = {1,2,3,5,8,13,21,34,55,89,144} días " +
    "sin salir desde su última aparición. Ciclo mayor (F34+) = pico máximo. P3/P4 · Día/Noche",
  createdBy: 728711697,
} as const;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("▶ seed-unodostres iniciando…");

  // 1. Cargar config de usuarios (Sheet o archivo)
  await initUserConfig();
  console.log(`  backend: ${getStorageBackend()}`);

  // 2. Si hay Sheet, cargar y conectar la pestaña de Estrategias
  if (getStorageBackend() === "sheet") {
    const rows = await loadStrategiesFromSheet();

    // Conectar el persister para que seedCustomMenus guarde en el Sheet
    setStrategySheetPersist((menus) =>
      saveStrategiesToSheet(
        menus.map((m) => ({
          id: m.id,
          titulo: m.label,
          descripcion: m.description ?? "",
          createdBy: m.createdBy ?? 0,
          price: m.price ?? "",
          visibility: m.visibility ?? "private",
          subscribers: m.subscribers ?? 0,
        }))
      )
    );

    initCustomMenusFromSheet(rows);
    console.log(`  estrategias existentes en Sheet: ${rows.length}`);
  }

  // 3. Insertar en el catálogo (no-op si ya existe)
  const newIds = seedCustomMenus([ENTRY]);
  if (newIds.length > 0) {
    console.log(`  ✅ "${ENTRY.id}" añadida al catálogo y guardada en ${getStorageBackend()}.`);
  } else {
    console.log(`  ℹ️  "${ENTRY.id}" ya existía en el catálogo; no se duplicó.`);
  }

  // 4. Asignar a todos los dueños
  const ownerIds = getOwnerIds();
  if (ownerIds.length === 0) {
    console.warn("  ⚠️  BOT_OWNER_ID no definido; no se asigna a ningún dueño.");
    return;
  }

  for (const ownerId of ownerIds) {
    const current = getUserAssignedMenuIds(ownerId);
    if (current.includes(ENTRY.id)) {
      console.log(`  ℹ️  dueño ${ownerId} ya tiene "${ENTRY.id}" asignado.`);
      continue;
    }
    await addAllowed(ownerId);
    await setExtraMenus(ownerId, [...current, ENTRY.id]);
    console.log(`  ✅ "${ENTRY.id}" asignada al dueño ${ownerId}.`);
  }

  console.log("✅ seed-unodostres completado.");
}

main().catch((e) => {
  console.error("❌ Error en seed-unodostres:", e);
  process.exit(1);
});
