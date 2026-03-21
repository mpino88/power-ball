/**
 * Script de seed one-shot: registra la estrategia "unodostres_plus" en el catálogo
 * (Sheet o archivo) y la asigna a todos los dueños del bot.
 *
 * Uso:
 *   npx tsx scripts/seed-unodostres-plus.ts
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
  id: "unodostres_plus",
  label: "UNODOSTRES+ (Finobacci Plus)",
  description:
    "Garantiza Resonancia Fibonacci mejorada y simplificada visualmente. " +
    "Detecta números en su pico cíclico. Permite Top 10, 20 o 30. " +
    "Muestra candidatos en fases de alerta (Mayor, Expansión, Corto Plazo). P3/P4 · Día/Noche",
  createdBy: 728711697,
} as const;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("▶ seed-unodostres-plus iniciando…");

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

  console.log("✅ seed-unodostres-plus completado.");
}

main().catch((e) => {
  console.error("❌ Error en seed-unodostres-plus:", e);
  process.exit(1);
});
