import { ILotteryScraper } from "../../domain/interfaces/ILotteryScraper.js";
import { DateDrawsMap } from "../../domain/models/Strategy.js";

const P3_PDF_URL = "https://files.floridalottery.com/exptkt/p3.pdf";
const P4_PDF_URL = "https://files.floridalottery.com/exptkt/p4.pdf";
const FLORIDA_TZ = "America/New_York";

const P3_RECORD_REGEX =
  /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;
const P4_RECORD_REGEX =
  /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;

async function pdfToText(pdfBuffer: ArrayBuffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(pdfBuffer);
  const doc = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
  }).promise;
  const numPages = doc.numPages;
  const pageTexts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    type Item = { str: string; transform?: number[] };
    const rawItems = content.items as Item[];
    const items = [...rawItems].sort((a, b) => {
      const yA = a.transform?.[5] ?? 0;
      const yB = b.transform?.[5] ?? 0;
      const xA = a.transform?.[4] ?? 0;
      const xB = b.transform?.[4] ?? 0;
      if (Math.abs(yA - yB) > 2) return yB - yA;
      return xA - xB;
    });
    let lastY: number | null = null;
    const lineParts: string[] = [];
    const lines: string[] = [];
    for (const item of items) {
      const y = item.transform?.[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(lineParts.join(" ").trim());
        lineParts.length = 0;
      }
      lastY = y;
      lineParts.push(item.str);
    }
    if (lineParts.length > 0) lines.push(lineParts.join(" ").trim());
    pageTexts.push(lines.join("\n"));
  }
  return pageTexts.join("\n");
}

function parseP3FullText(text: string): DateDrawsMap {
  const map: DateDrawsMap = {};
  const normalized = text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let m: RegExpExecArray | null;
  P3_RECORD_REGEX.lastIndex = 0;
  while ((m = P3_RECORD_REGEX.exec(normalized)) !== null) {
    const date = m[1]!;
    const type = m[2]!.toUpperCase() === "E" ? "e" : "m";
    const numbers = [Number(m[3]), Number(m[4]), Number(m[5])];
    if (!map[date]) map[date] = {};
    map[date][type] = numbers;
  }
  return map;
}

function parseP4FullText(text: string): DateDrawsMap {
  const map: DateDrawsMap = {};
  const normalized = text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let m: RegExpExecArray | null;
  P4_RECORD_REGEX.lastIndex = 0;
  while ((m = P4_RECORD_REGEX.exec(normalized)) !== null) {
    const date = m[1]!;
    const type = m[2]!.toUpperCase() === "E" ? "e" : "m";
    const numbers = [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
    if (!map[date]) map[date] = {};
    map[date][type] = numbers;
  }
  return map;
}

function getLastExpectedUpdateTime(): number {
  const floridaNowStr = new Date().toLocaleString("en-US", { timeZone: FLORIDA_TZ });
  const floridaNow = new Date(floridaNowStr);
  
  const t1405 = new Date(floridaNow);
  t1405.setHours(14, 5, 0, 0);
  
  const t2020 = new Date(floridaNow);
  t2020.setHours(20, 20, 0, 0);

  if (floridaNow.getTime() >= t2020.getTime()) return t2020.getTime();
  if (floridaNow.getTime() >= t1405.getTime()) return t1405.getTime();
  
  const yesterday2020 = new Date(t2020);
  yesterday2020.setDate(yesterday2020.getDate() - 1);
  return yesterday2020.getTime();
}

export class FloridaLotteryScraper implements ILotteryScraper {
  private cachedP3Map: DateDrawsMap | null = null;
  private cachedP4Map: DateDrawsMap | null = null;
  private lastP3Fetch = 0;
  private lastP4Fetch = 0;

  async getP3Map(): Promise<DateDrawsMap> {
    const leut = getLastExpectedUpdateTime();
    if (this.cachedP3Map && this.lastP3Fetch >= leut) return this.cachedP3Map;
    
    console.log(`[FloridaLotteryScraper] Refrescando mapa P3 (Evento: ${this.lastP3Fetch < leut ? "Nuevo sorteo disponible" : "Inicio"})`);
    const res = await fetch(P3_PDF_URL, { headers: { "User-Agent": "FloridaLotteryBot/1.0" } });
    if (!res.ok) throw new Error(`P3 PDF ${res.status}`);
    const data = await res.arrayBuffer();
    const txt = await pdfToText(data);
    this.cachedP3Map = parseP3FullText(txt);
    this.lastP3Fetch = Date.now();
    return this.cachedP3Map;
  }

  async getP4Map(): Promise<DateDrawsMap> {
    const leut = getLastExpectedUpdateTime();
    if (this.cachedP4Map && this.lastP4Fetch >= leut) return this.cachedP4Map;
    
    console.log(`[FloridaLotteryScraper] Refrescando mapa P4 (Evento: ${this.lastP4Fetch < leut ? "Nuevo sorteo disponible" : "Inicio"})`);
    const res = await fetch(P4_PDF_URL, { headers: { "User-Agent": "FloridaLotteryBot/1.0" } });
    if (!res.ok) throw new Error(`P4 PDF ${res.status}`);
    const data = await res.arrayBuffer();
    const txt = await pdfToText(data);
    this.cachedP4Map = parseP4FullText(txt);
    this.lastP4Fetch = Date.now();
    return this.cachedP4Map;
  }

  async forceRefresh(): Promise<void> {
    this.cachedP3Map = null;
    this.cachedP4Map = null;
    this.lastP3Fetch = 0;
    this.lastP4Fetch = 0;
    await Promise.all([this.getP3Map(), this.getP4Map()]);
  }
}
