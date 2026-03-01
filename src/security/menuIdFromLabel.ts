/**
 * Genera el id de menú a partir del texto del botón: lowercase, snake_case, sin acentos ni caracteres extraños.
 * Ese id se usa después para asociar la funcionalidad del botón.
 */

const ACCENTS: Record<string, string> = {
  á: "a", é: "e", í: "i", ó: "o", ú: "u", ñ: "n",
  à: "a", è: "e", ì: "i", ò: "o", ù: "u",
  â: "a", ê: "e", î: "i", ô: "o", û: "u",
  ä: "a", ë: "e", ï: "i", ö: "o", ü: "u",
  Á: "a", É: "e", Í: "i", Ó: "o", Ú: "u", Ñ: "n",
};

/**
 * Convierte el texto del botón a un id válido: minúsculas, snake_case, sin acentos ni caracteres raros.
 * Ej: "Fechas Calor" → "fechas_calor", "Área 51" → "area_51"
 */
export function labelToMenuId(label: string): string {
  let s = label.trim();
  if (!s) return "";
  s = s.toLowerCase();
  const withoutAccents = [...s].map((c) => ACCENTS[c] ?? c).join("");
  const snake = withoutAccents
    .replace(/[^a-z0-9\s_-]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return snake;
}
