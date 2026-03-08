/**
 * Módulo "Crear Adivinanza" (solo dueño del bot).
 *
 * Genera adivinanzas poéticas en español cubano a partir de una lista de números
 * de lotería usando la API de Google Gemini (el mismo modelo que alimenta NotebookLM).
 *
 * Variable de entorno requerida: GEMINI_API_KEY
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { InlineKeyboard } from "grammy";

// ─── Cliente Gemini (lazy init) ───────────────────────────────────────────────

let genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const key = process.env.GEMINI_API_KEY?.trim() ?? "";
    if (!key) throw new Error("GEMINI_API_KEY no está configurada.");
    genAI = new GoogleGenerativeAI(key);
  }
  return genAI;
}

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

/**
 * Llama a la API REST para obtener todos los modelos disponibles con la API key actual.
 * Filtra solo los que soportan generateContent.
 */
export async function listarModelosGemini(): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY?.trim() ?? "";
  if (!key) throw new Error("GEMINI_API_KEY no está configurada.");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[${res.status}] ${body}`);
  }
  const data = await res.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
  return (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace("models/", ""));
}

// ─── Función principal ────────────────────────────────────────────────────────

/** Modelos a intentar en orden; el primero disponible se usa. */
const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash"];

/**
 * Llama a Gemini y devuelve la adivinanza generada para los números dados.
 * Prueba los modelos en orden hasta que uno funcione.
 * Relanza con mensaje descriptivo para que el dueño vea la causa en Telegram.
 */
export async function generarAdivinanza(numbers: number[]): Promise<string> {
  const ai = getGenAI();
  const prompt = buildPrompt(numbers);
  let lastError: unknown;

  for (const modelName of GEMINI_MODELS) {
    try {
      const model = ai.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      if (text) return text;
    } catch (err) {
      lastError = err;
      console.warn(`[adivinanza] Modelo ${modelName} falló:`, err);
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(msg);
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
