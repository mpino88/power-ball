import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const CONFIG_DIR = path.join(process.cwd(), "data");
const PREVIEWS_FILE = path.join(CONFIG_DIR, "strategy-previews.json");

// userId -> Array of menuIds they have previewed
type StrategyPreviews = Record<string, string[]>;

let previews: StrategyPreviews = {};

export function loadStrategyPreviews(): void {
  try {
    if (existsSync(PREVIEWS_FILE)) {
      const raw = readFileSync(PREVIEWS_FILE, "utf8");
      previews = JSON.parse(raw) as StrategyPreviews;
      console.log(`[strategy-previews] Cargados datos de vista previa para ${Object.keys(previews).length} usuarios.`);
    } else {
      previews = {};
    }
  } catch (error) {
    console.error("[strategy-previews] Error cargando strategy-previews.json:", error);
    previews = {}; // Fallback to empty
  }
}

export function saveStrategyPreviews(): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(PREVIEWS_FILE, JSON.stringify(previews, null, 2), "utf8");
  } catch (error) {
    console.error("[strategy-previews] Error guardando strategy-previews.json:", error);
  }
}

export function hasPreviewedStrategy(userId: number, menuId: string): boolean {
  const userPreviews = previews[String(userId)];
  if (!userPreviews) return false;
  return userPreviews.includes(menuId);
}

export function markStrategyAsPreviewed(userId: number, menuId: string): void {
  const userKey = String(userId);
  if (!previews[userKey]) {
    previews[userKey] = [];
  }
  
  if (!previews[userKey].includes(menuId)) {
    previews[userKey].push(menuId);
    saveStrategyPreviews();
  }
}
