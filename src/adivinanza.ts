/**
 * Módulo "Crear Adivinanza" (solo dueño del bot).
 *
 * Genera adivinanzas poéticas en español cubano a partir de una lista de números
 * de lotería usando la API de Google Gemini (el mismo modelo que alimenta NotebookLM).
 *
 * Variable de entorno requerida: GEMINI_API_KEY
 */

import { InlineKeyboard } from "grammy";

// ─── API key ──────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim() ?? "";
  if (!key) throw new Error("GEMINI_API_KEY no está configurada.");
  return key;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// ─── Constantes ───────────────────────────────────────────────────────────────

export const ADIVINANZA_OPEN_CB = "adivinanza_open";
export const ADIVINANZA_INGRESAR_CB = "adivinanza_ingresar";
export const ADIVINANZA_REGEN_PREFIX = "adivinanza_regen|";

/**
 * Prefijo para el botón "Crear Adivinanza" de una estrategia individual.
 * Formato: adivinanza_strat_<menuId>_<p3|p4>_<m|e>  (≤ 64 bytes ✓)
 */
export const ADIVINANZA_STRAT_PREFIX = "adivinanza_strat_";

/** Callback especial para la adivinanza generada desde el Consenso Multi-Estrategia. */
export const ADIVINANZA_CNS_CALLBACK = "adivinanza_cns";

export const ADIVINANZA_OPEN_MSG =
  "🔮 *Crear Adivinanza con IA*\n\n" +
  "Genera una adivinanza poética a partir de una lista de números de lotería\\.\n\n" +
  "El resultado puede compartirse con tus jugadores como pista críptica del próximo sorteo\\.\n\n" +
  "_Pulsa_ *Ingresar números* _para comenzar\\._";

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(numbers: number[]): string {
  return (
    "Eres un adivino y poeta cubano especializado en la charada y la lotería. " +
    "Tu tarea es crear una «adivinanza» (enigma poético en español cubano) para los siguientes " +
    `números de lotería: ${numbers.join(", ")}.\n\n` +
    "Reglas estrictas:\n" +
    "- Entre 4 y 8 versos poéticos, con rima asonante o consonante.\n" +
    "- Usa imágenes, simbolismos, naturaleza, animales o escenas cotidianas cubanas.\n" +
    "- La adivinanza debe ser críptica pero con pistas que lleven al lector a descubrir los números.\n" +
    "- No menciones los números directamente en los versos.\n" +
    "- Al final agrega una sección «Clave:» con los números en un formato cifrado divertido " +
    "  (ej: suma de dígitos, inversión de cifras, suma total).\n" +
    "- Tono: misterioso, poético y entretenido.\n" +
    "- Idioma: español cubano natural.\n\n" +
    "Responde SOLO con la adivinanza y la clave. Sin explicaciones ni comentarios adicionales."
  );
}

// ─── Listar modelos disponibles ───────────────────────────────────────────────

type GeminiModel = { name: string; supportedGenerationMethods?: string[] };

/**
 * Llama a la API REST para obtener todos los modelos disponibles con la API key actual.
 * Filtra solo los que soportan generateContent.
 */
export async function listarModelosGemini(): Promise<string[]> {
  const key = getApiKey();
  const res = await fetch(`${GEMINI_BASE}/models?key=${key}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[${res.status}] ${body}`);
  }
  const data = await res.json() as { models?: GeminiModel[] };
  return (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace("models/", ""));
}

// ─── Función principal ────────────────────────────────────────────────────────

/** Caché del primer modelo disponible detectado en runtime. */
let cachedModel: string | null = null;

/**
 * Detecta el primer modelo Flash disponible con la API key actual.
 * Prefiere flash por velocidad y costo; tiene caché en memoria.
 */
async function detectModel(): Promise<string> {
  if (cachedModel) return cachedModel;
  const all = await listarModelosGemini();
  // Prioridad: flash > pro > cualquiera
  const preferred = all.find((m) => /flash/i.test(m)) ?? all.find((m) => /pro/i.test(m)) ?? all[0];
  if (!preferred) throw new Error("No hay modelos Gemini disponibles con esta API key.");
  cachedModel = preferred;
  console.log(`[adivinanza] Modelo detectado: ${preferred}`);
  return preferred;
}

/**
 * Genera una adivinanza vía REST puro (sin SDK), auto-detectando el modelo disponible.
 * Relanza con mensaje descriptivo para que el dueño vea la causa en Telegram.
 */
export async function generarAdivinanza(numbers: number[]): Promise<string> {
  const key = getApiKey();
  const model = await detectModel();
  const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${key}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(numbers) }] }],
    }),
  });

  if (!res.ok) {
    // Si el modelo en caché ya no funciona, borramos la caché para reintentar la próxima vez
    cachedModel = null;
    const body = await res.text();
    throw new Error(`[${res.status} ${model}] ${body}`);
  }

  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  if (!text) throw new Error("La API devolvió una respuesta vacía.");
  return text;
}

// ─── Teclados ────────────────────────────────────────────────────────────────

export function buildAdivinanzaMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔢 Ingresar números", ADIVINANZA_INGRESAR_CB)
    .row()
    .text("◀️ Volver", "volver");
}

export function buildAdivinanzaResultKeyboard(numbers: number[]): InlineKeyboard {
  const encoded = numbers.join(",");
  return new InlineKeyboard()
    .text("🔄 Regenerar", ADIVINANZA_REGEN_PREFIX + encoded)
    .text("✏️ Nuevos números", ADIVINANZA_INGRESAR_CB)
    .row()
    .text("🏠 Inicio", "volver");
}

// ─── Parseo de números ───────────────────────────────────────────────────────

/**
 * Parsea un texto libre con números separados por espacios, comas o guiones.
 * Devuelve null si no se encontraron números válidos o si la lista excede el máximo.
 */
export function parseNumberList(text: string, max = 20): number[] | null {
  const nums = text
    .split(/[\s,;|\-]+/)
    .map((t) => t.trim())
    .filter((t) => /^\d+$/.test(t))
    .map(Number)
    .filter((n) => n >= 0 && n <= 9999);

  if (nums.length === 0 || nums.length > max) return null;
  return nums;
}

// ─── Callback helpers (estrategia individual) ────────────────────────────────

/**
 * Construye el callback data para el botón "Crear Adivinanza" de una estrategia.
 * Mismo formato que buildParleCallback pero con prefijo adivinanza_strat_.
 */
export function buildAdivinanzaStratCallback(
  menuId: string,
  mapSource: "p3" | "p4",
  period: "m" | "e"
): string {
  return `${ADIVINANZA_STRAT_PREFIX}${menuId}_${mapSource}_${period}`;
}

/**
 * Parsea un callback data de adivinanza de estrategia individual.
 * Retorna null si el dato no corresponde a este formato.
 */
export function parseAdivinanzaStratCallback(
  data: string
): { menuId: string; context: { mapSource: "p3" | "p4"; period: "m" | "e" } } | null {
  if (!data.startsWith(ADIVINANZA_STRAT_PREFIX)) return null;
  const rest = data.slice(ADIVINANZA_STRAT_PREFIX.length);
  const parts = rest.split("_");
  if (parts.length < 3) return null;
  const period = parts[parts.length - 1];
  const mapSource = parts[parts.length - 2];
  if (mapSource !== "p3" && mapSource !== "p4") return null;
  if (period !== "m" && period !== "e") return null;
  const menuId = parts.slice(0, -2).join("_");
  if (!menuId) return null;
  return { menuId, context: { mapSource, period } };
}

// ─── Helpers de mensajes ─────────────────────────────────────────────────────

export function buildAdivinanzaResultMsg(adivinanza: string, numbers: number[]): string {
  const lista = numbers.map((n) => `\`${n}\``).join(" · ");
  return (
    `🔮 *Adivinanza generada con IA*\n\n` +
    `_Números base:_ ${lista}\n\n` +
    `─────────────────────\n\n` +
    `${adivinanza}`
  );
}
