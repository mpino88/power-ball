/**
 * Charada Cubana — Sistema de numerología popular cubano.
 * Asigna significados (palabras clave) a los números 00-99.
 * El número 100 de la charada tradicional equivale al 00 en este sistema.
 *
 * Accesible para todos los usuarios del bot.
 */

import { InlineKeyboard } from "grammy";
import { CONSULTAR_DATOS_CALLBACK } from "./menus/keyboards.js";

// ─── Datos ───────────────────────────────────────────────────────────────────
// Clave: número 0-99 (0 = 00 = charada 100)

export const CHARADA: Record<number, string[]> = {
  0:  ["Inodoro", "Dios", "Escoba", "Automóvil"],
  1:  ["Caballo", "Sol", "Tintero", "Camello", "Pescado Chico"],
  2:  ["Mariposa", "Hombre", "Cafetera", "Caracol"],
  3:  ["Marinero", "Luna", "Taza", "Ciempiés", "Muerto"],
  4:  ["Gato", "Soldado", "Llave", "Vela", "Militar", "Pavo Real"],
  5:  ["Monja", "Mar", "Candado", "Periódico", "Fruta", "Lombriz"],
  6:  ["Jicotea", "Carta", "Reverbero", "Botella", "Luna"],
  7:  ["Caracol", "Sueño", "Heces Fecales", "Medias", "Caballero", "Cochino"],
  8:  ["Muerto", "León", "Calabaza", "Mesa", "Tigre"],
  9:  ["Elefante", "Entierro", "Lira", "Cubo", "Esqueleto", "Buey"],
  10: ["Pescado Grande", "Paseo", "Malla", "Cazuela", "Dinero", "Lancha"],
  11: ["Gallo", "Lluvia", "Fósforo", "Taller", "Fábrica", "Caballo"],
  12: ["Mujer Santa", "Viaje", "Toallas", "Cometa", "Dama", "Perro Grande"],
  13: ["Pavo Real", "Niño", "Anafe", "Elefante"],
  14: ["Gato", "Tigre", "Matrimonio", "Arreste", "Sartén", "Cementerio"],
  15: ["Perro", "Visita", "Cuchara", "Gallo", "Ratón"],
  16: ["Toro", "Plancha", "Vestido", "Incendio pequeño", "Funerales", "Avispa"],
  17: ["Luna", "Mujer buena", "Hule", "Camisón", "Armas", "Fumar opio"],
  18: ["Pescado Chiquito", "Iglesia", "Sirena", "Palma", "Pescado", "Gato amarillo"],
  19: ["Lombriz", "Campesino", "Tropa", "Mesa Grande", "Armadura", "Jutía"],
  20: ["Gato Fino", "Cañón", "Camiseta", "Orinal", "Libro", "Mujer"],
  21: ["Majá", "Reloj de bolsillo", "Chaleco", "Cotorra", "Cigarro", "Gallo"],
  22: ["Sapo", "Estrella", "Lirio", "Chimenea", "Sol", "Jicotea"],
  23: ["Vapor", "Submarino", "Monte", "Escalera", "Barco", "Águila"],
  24: ["Paloma", "Música", "Carpintero", "Cocina", "Pescado Grande"],
  25: ["Piedra Fina", "Casa", "Sol", "Monja", "Rana"],
  26: ["Anguila", "Calle", "Médico", "Brillante", "Nube de Oro"],
  27: ["Avispa", "Campana", "Cuchara Grande", "Canario", "Baúl", "Mono"],
  28: ["Chivo", "Bandera", "Político", "Uvas", "Perro Chico"],
  29: ["Ratón", "Nube", "Venado", "Águila"],
  30: ["Camarón", "Arco Iris", "Almanaque", "Buey", "Cangrejo", "Chivo"],
  31: ["Venado", "Escuela", "Zapatos", "Pato"],
  32: ["Cochino", "Enemigo", "Mulo", "Demonio", "Maja"],
  33: ["Tiñosa", "Baraja", "Santa", "Jesucristo", "Bofetón", "Camarón"],
  34: ["Mono", "Familia", "Negro", "Capataz", "Paloma"],
  35: ["Araña", "Novia", "Bombillos", "Mosquito", "Mariposa"],
  36: ["Cachimba", "Teatro", "Bodega", "Opio", "Coloso", "Pajarito"],
  37: ["Gallina Prieta", "Gitana", "Hormiga", "Carretera", "Piedra Fina"],
  38: ["Dinero", "Macao", "Carro", "Goleta", "Guantes", "Barril"],
  39: ["Conejo", "Culebra", "Rayo", "Baile", "Tintorero"],
  40: ["Cura", "Sangre", "Bombero", "Muchacho Maldita", "Cantina", "Estatua"],
  41: ["Lagartija", "Prisión", "Pato Chico", "Jubo", "Capuchino", "Clarín"],
  42: ["Pato", "País Lejano", "Carnero", "España", "Abismo", "Liga"],
  43: ["Alacrán", "Amigo", "Vaca", "Puerta", "Presidiario", "Jorobado"],
  44: ["Año del Cuero", "Infierno", "Año Malo", "Temporal", "Tormenta", "Plancha"],
  45: ["Tiburón", "Presidente", "Traje", "Tranvía", "Escuela", "Estrella"],
  46: ["Guagua", "Humo", "Hambre", "Hurón", "Baile", "Chino"],
  47: ["Pájaro", "Mala Noticia", "Mucha Sangre", "Escolta", "Gallo", "Rosa"],
  48: ["Cucaracha", "Abanico", "Barbería", "Cubo"],
  49: ["Borracho", "Riqueza", "Figurín", "Percha", "Tesoro", "Fantasma"],
  50: ["Policía", "Alegría", "Florero", "Alcalde", "Pícaro", "Árbol"],
  51: ["Soldado", "Sed", "Oro", "Sereno", "Anteojos", "Presillas"],
  52: ["Bicicleta", "Coche", "Borracho", "Abogado", "Riña", "Libreta"],
  53: ["Luz Eléctrica", "Prenda", "Tragedia", "Diamante", "Beso", "Alguacil"],
  54: ["Flores", "Gallina Blanca", "Sueño", "Timbre", "Cañón", "Rosas"],
  55: ["Cangrejo", "Baile", "Iglesia Grande", "Los Isleños", "Caerse", "Sellos"],
  56: ["Reina", "Escorpión", "Pato Grande", "Merengue", "Piedra", "Cara"],
  57: ["Cama", "Ángeles", "Telegrama", "Puerta"],
  58: ["Adulterio", "Retrato", "Cuchillo", "Cangrejo", "Ferretero", "Batea"],
  59: ["Loco", "Fonógrafo", "Langosta", "Anillo", "Araña Grande"],
  60: ["Sol Oscuro", "Payaso", "Cómico", "Tempestad", "Avecillas"],
  61: ["Cañonazo", "Piedra Grande", "Revólver", "Boticario", "Pintor", "Saco"],
  62: ["Matrimonio", "Nieve", "Lámpara", "Visión", "Academia", "Carretilla"],
  63: ["Asesino", "Cuernos", "Espada", "Bandidos", "Caracol", "Escalera"],
  64: ["Muerto Grande", "Tiro de Rifle", "Maromero", "Relajo", "Fiera"],
  65: ["Cárcel", "Comida", "Bruja", "Ventana", "Trueno"],
  66: ["Divorcio", "Tarros", "Máscara", "Estrella", "Mudada", "Carnaval"],
  67: ["Puñalada", "Reloj", "Autoridad", "Fonda", "Aborto", "Zapato"],
  68: ["Cementerio Grande", "Globo", "Cuchillo Grande", "Templo", "Bolos", "Dinero"],
  69: ["Pozo", "Fiera", "Loma", "Vagos", "Polvorín"],
  70: ["Teléfono", "Coco", "Tiro", "Barril", "Arco Iris", "Bala"],
  71: ["Río", "Sombrero", "Perro Mediano", "Pantera", "Fusil"],
  72: ["Ferrocarril", "Buey Viejo", "Serrucho", "Collar", "Cetro", "Relámpago"],
  73: ["Parque", "Navaja", "Manzanas", "Maleta", "Ajedrez", "Cigarrillo"],
  74: ["Papalote", "Coronel", "Serpiente", "Cólera", "Tarima"],
  75: ["Cine", "Corbata", "Viento", "Guitarra", "Flores", "Quiosco"],
  76: ["Bailarina", "Humo en Cantidad", "Caja de Hierro", "Violín"],
  77: ["Banderas", "Guerra", "Colegio", "Billetes de Banco", "Ánfora"],
  78: ["Obispo", "Tigre", "Sarcófago", "Rey", "Apetito", "Lunares"],
  79: ["Coche", "Lagarto", "Abogado", "Tren de Carga o de Viajeros", "Dulces"],
  80: ["Médico", "Buena Noticia", "Luna Llena", "Paraguas", "Barba", "Trompo"],
  81: ["Teatro", "Barco", "Navaja Grande", "Ingeniero", "Cuerda", "Actriz"],
  82: ["Madre", "León", "Batea", "Pleito", "Estrella", "Muelle"],
  83: ["Tragedia", "Procesión", "Limosnero", "Bastón", "Madera"],
  84: ["Ciego", "Sastre", "Bohío", "Banquero", "Cofre", "Marcha Atrás"],
  85: ["Reloj", "Madrid", "Águila", "Espejo", "Guano"],
  86: ["Convento", "Marino", "Ardilla", "Tijera", "Desnudar", "Palma"],
  87: ["Nueva York", "Baúl", "Paloma", "Fuego", "Plátanos"],
  88: ["Espejuelos", "Gusano", "Vaso", "Hojas", "Aduanero"],
  89: ["Lotería", "Agua", "Mona Vieja", "Cometa", "Melón", "Tesorero"],
  90: ["Viejo", "Espejo Grande", "Caramelo", "Temporal", "Asesino"],
  91: ["Tranvía", "Pájaro Negro", "Limosnero", "Alpargatas", "Bolsas", "Bolchevique"],
  92: ["Globo muy Alto", "Suicidio", "Cuba", "Anarquista", "Gato", "León Grande"],
  93: ["Revolución", "Sortija de Valor", "General", "Andarín", "Joyas", "Libertad"],
  94: ["Machete", "Mariposa Grande", "Leontina Perfume", "Habana", "Flores"],
  95: ["Guerra", "Perro Grande", "Alacrán Grande", "Espada", "Matanzas", "Revolución"],
  96: ["Desafío", "Periódico", "Pícaro", "Zapatos Nuevos", "Roca", "Mujer Santa"],
  97: ["Mosquito Grande", "Mono Grande", "Sinsonte", "Grillo Grande", "Limosnero"],
  98: ["Piano", "Entierro Grande", "Traición", "Visita Regia", "Fonógrafo"],
  99: ["Serrucho", "Gallo Grande", "Temporal muy Grande", "Carbonero", "Lluvia"],
};

// ─── Constantes de paginación ─────────────────────────────────────────────────

export const CHARADA_PER_PAGE = 20;
export const CHARADA_TOTAL_PAGES = Math.ceil(100 / CHARADA_PER_PAGE); // 5

// ─── Formateadores ────────────────────────────────────────────────────────────

function numLabel(n: number): string {
  return String(n).padStart(2, "0");
}

/** Formatea una entrada de la charada como una línea de texto. */
export function formatEntryLine(num: number): string {
  const keywords = CHARADA[num];
  if (!keywords || keywords.length === 0) return `*${numLabel(num)}* · _(sin datos)_`;
  return `*${numLabel(num)}* · ${keywords.join(", ")}`;
}

/** Construye el mensaje del catálogo paginado (page 0-indexed). */
export function buildCatalogPage(page: number): string {
  const start = page * CHARADA_PER_PAGE;
  const end = Math.min(start + CHARADA_PER_PAGE, 100);

  const lines: string[] = [
    `🃏 *Charada Cubana* — Pág ${page + 1}/${CHARADA_TOTAL_PAGES} (${numLabel(start)}–${numLabel(end - 1)})`,
    "",
  ];

  for (let n = start; n < end; n++) {
    lines.push(formatEntryLine(n));
  }

  return lines.join("\n");
}

// ─── Búsqueda ─────────────────────────────────────────────────────────────────

/** Normaliza un texto eliminando acentos y convirtiendo a minúsculas para comparación. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export interface CharadaMatch {
  num: number;
  keywords: string[];
}

/**
 * Busca en la charada por número o texto.
 * - Si la query es un número entero 0-99 (o "00"-"99"): devuelve solo ese resultado.
 * - Si es texto: busca coincidencias parciales (insensible a mayúsculas/acentos) en keywords.
 */
export function searchCharada(query: string): CharadaMatch[] {
  const trimmed = query.trim();

  // Búsqueda por número
  const maybeNum = parseInt(trimmed, 10);
  if (!Number.isNaN(maybeNum) && maybeNum >= 0 && maybeNum <= 99 && /^\d{1,2}$/.test(trimmed)) {
    const keywords = CHARADA[maybeNum] ?? [];
    return [{ num: maybeNum, keywords }];
  }

  // Búsqueda por texto
  const needle = normalize(trimmed);
  if (needle.length < 2) return [];

  const results: CharadaMatch[] = [];
  for (let n = 0; n < 100; n++) {
    const keywords = CHARADA[n] ?? [];
    const hit = keywords.some((kw) => normalize(kw).includes(needle));
    if (hit) results.push({ num: n, keywords });
  }
  return results;
}

/** Construye el mensaje de resultado de búsqueda. */
export function buildSearchMessage(query: string, results: CharadaMatch[]): string {
  const trimmed = query.trim();
  const maybeNum = parseInt(trimmed, 10);
  const isNumSearch = !Number.isNaN(maybeNum) && maybeNum >= 0 && maybeNum <= 99 && /^\d{1,2}$/.test(trimmed);

  if (results.length === 0) {
    return (
      `🔍 *Búsqueda: "${trimmed}"*\n\n` +
      `_No se encontraron coincidencias en la Charada Cubana._\n\n` +
      `Intenta con otro número (00–99) o una palabra diferente.`
    );
  }

  const header = isNumSearch
    ? `🔍 *Número ${numLabel(maybeNum)}*`
    : `🔍 *Búsqueda: "${trimmed}"* — ${results.length} coincidencia${results.length > 1 ? "s" : ""}`;

  const lines = [header, ""];
  for (const { num, keywords } of results) {
    lines.push(formatEntryLine(num));
  }
  return lines.join("\n");
}

// ─── Teclados ─────────────────────────────────────────────────────────────────

/** Teclado del submenú principal de la Charada. */
export function buildCharadaMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Catálogo", "charada_cat_0")
    .text("🔍 Buscar", "charada_buscar")
    .row()
    .text("◀️ Volver", CONSULTAR_DATOS_CALLBACK);
}

/** Teclado de navegación del catálogo paginado. */
export function buildCharadaCatalogKeyboard(page: number): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Nav row
  if (page > 0) {
    kb.text("◀️ Anterior", `charada_cat_${page - 1}`);
  } else {
    kb.text("·", "charada_noop"); // placeholder invisible
  }

  kb.text(`Pág ${page + 1}/${CHARADA_TOTAL_PAGES}`, "charada_noop");

  if (page < CHARADA_TOTAL_PAGES - 1) {
    kb.text("Siguiente ▶️", `charada_cat_${page + 1}`);
  } else {
    kb.text("·", "charada_noop");
  }

  kb.row().text("🃏 Menú Charada", "charada_open").row().text("◀️ Volver", "volver");

  return kb;
}
