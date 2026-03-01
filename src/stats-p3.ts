/**
 * Estadísticas P3 por grupos (terminales, iniciales, dobles) e individuales (00-99).
 * Un solo recorrido del historial. El periodo indica si usar solo Mediodía (M) o Noche (E).
 */

export type StatsPeriod = "M" | "E";

/** Mapa compatible con bot: fecha MM/DD/YY → { m?, e? } con arrays de 3 números. */
export type DateDrawsMapStats = Record<string, { m?: number[]; e?: number[] }>;

export interface GroupGap {
  maxGapDays: number;
  currentGapDays: number | null;
}

function mmddyyToDate(key: string): Date | null {
  const m = key.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const dd = parseInt(m[2], 10);
  let yy = parseInt(m[3], 10);
  yy = yy >= 50 ? 1900 + yy : 2000 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(yy, mm - 1, dd);
  if (d.getDate() !== dd || d.getMonth() !== mm - 1) return null;
  return d;
}

function sortDateKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const da = mmddyyToDate(a)?.getTime() ?? 0;
    const db = mmddyyToDate(b)?.getTime() ?? 0;
    return da - db;
  });
}

function twoDigitFromP3(draw: number[]): number {
  if (draw.length < 3) return 0;
  return draw[1]! * 10 + draw[2]!;
}

const DOUBLES_SET = new Set([0, 11, 22, 33, 44, 55, 66, 77, 88, 99]);

type Track = { counter: number; maxHistorical: number; everAppeared: boolean };

const toGap = (t: Track): GroupGap => ({
  maxGapDays: t.maxHistorical,
  currentGapDays: t.everAppeared ? t.counter : null,
});

/**
 * Un solo recorrido: estadísticas de grupos e individuales usando solo el periodo indicado (M o E).
 */
export function computeStatsCombined(
  map: DateDrawsMapStats,
  period: StatsPeriod
): {
  groups: { terminales: GroupGap[]; iniciales: GroupGap[]; dobles: GroupGap };
  individual: GroupGap[];
} {
  const sortedDates = sortDateKeys(Object.keys(map));
  const key = period === "M" ? "m" : "e";
  const emptyGap = (): GroupGap[] => Array.from({ length: 10 }, () => ({ maxGapDays: 0, currentGapDays: null }));
  if (sortedDates.length === 0) {
    return {
      groups: { terminales: emptyGap(), iniciales: emptyGap(), dobles: { maxGapDays: 0, currentGapDays: null } },
      individual: Array.from({ length: 100 }, () => ({ maxGapDays: 0, currentGapDays: null })),
    };
  }

  const dayDiff = (aStr: string, bStr: string): number => {
    const da = mmddyyToDate(aStr)?.getTime();
    const db = mmddyyToDate(bStr)?.getTime();
    if (da == null || db == null) return 0;
    return Math.round((db - da) / 864e5);
  };

  const initTrack = (): Track => ({ counter: 0, maxHistorical: 0, everAppeared: false });
  const terminales = Array.from({ length: 10 }, () => initTrack());
  const iniciales = Array.from({ length: 10 }, () => initTrack());
  const doblesTrack = initTrack();
  const individualTracks = Array.from({ length: 100 }, () => initTrack());

  let prevDateStr: string | null = null;

  for (const dateStr of sortedDates) {
    const draws = map[dateStr];
    const draw = draws?.[key];
    const numbersThisDay = new Set<number>();
    const groupsThisDay = new Set<string>();
    if (draw && draw.length >= 3) {
      const n = twoDigitFromP3(draw);
      numbersThisDay.add(n);
      groupsThisDay.add(`T${n % 10}`);
      groupsThisDay.add(`I${Math.floor(n / 10)}`);
      if (DOUBLES_SET.has(n)) groupsThisDay.add("D");
    }

    const daysSincePrev = prevDateStr !== null ? dayDiff(prevDateStr, dateStr) : 0;

    const tick = (t: Track, appeared: boolean) => {
      if (appeared) {
        if (t.counter > t.maxHistorical) t.maxHistorical = t.counter;
        t.counter = 0;
        t.everAppeared = true;
      } else {
        t.counter += daysSincePrev;
      }
    };

    for (let k = 0; k < 10; k++) tick(terminales[k]!, groupsThisDay.has(`T${k}`));
    for (let k = 0; k < 10; k++) tick(iniciales[k]!, groupsThisDay.has(`I${k}`));
    tick(doblesTrack, groupsThisDay.has("D"));
    for (let n = 0; n < 100; n++) tick(individualTracks[n]!, numbersThisDay.has(n));

    prevDateStr = dateStr;
  }

  return {
    groups: {
      terminales: terminales.map(toGap),
      iniciales: iniciales.map(toGap),
      dobles: toGap(doblesTrack),
    },
    individual: individualTracks.map(toGap),
  };
}

function getTop10HottestIndividual(
  stats: GroupGap[]
): { num: number; maxGapDays: number; currentGapDays: number }[] {
  const withCur: { num: number; maxGapDays: number; currentGapDays: number }[] = [];
  for (let n = 0; n < 100; n++) {
    const s = stats[n]!;
    if (s.currentGapDays !== null)
      withCur.push({ num: n, maxGapDays: s.maxGapDays, currentGapDays: s.currentGapDays });
  }
  withCur.sort((a, b) => a.maxGapDays - a.currentGapDays - (b.maxGapDays - b.currentGapDays));
  return withCur.slice(0, 10);
}

const PERIOD_LABEL: Record<StatsPeriod, string> = {
  M: "☀️ Mediodía (M)",
  E: "🌙 Noche (E)",
};

export function buildIndividualTop10Message(
  map: DateDrawsMapStats,
  diasDiferencia: number,
  period: StatsPeriod
): string {
  const { individual: stats } = computeStatsCombined(map, period);
  const top10 = getTop10HottestIndividual(stats);
  const W_NUM = 6;
  const W_MAX = 10;
  const W_ACT = 10;
  const W_HOT = 8;
  const fmt = (num: number, maxH: number, cur: number) => {
    const diff = maxH - cur;
    const hotStr = diff <= diasDiferencia ? "🔥 Hot" : String(diff);
    return (
      String(num).padStart(2, "0").padEnd(W_NUM) +
      String(maxH).padStart(W_MAX) +
      String(cur).padStart(W_ACT) +
      hotStr.padStart(W_HOT)
    );
  };
  const sep = "─".repeat(W_NUM + W_MAX + W_ACT + W_HOT);
  const header =
    "Número".padEnd(W_NUM) + "Máx.hist".padStart(W_MAX) + "Máx.actual".padStart(W_ACT) + "Hot/diff".padStart(W_HOT);
  const lines: string[] = [
    `📈 *Top 10 más Hot* — ${PERIOD_LABEL[period]} (2 últimos dígitos P3)\n`,
    "```",
    header,
    sep,
    ...top10.map(({ num, maxGapDays, currentGapDays }) => fmt(num, maxGapDays, currentGapDays)),
    "```",
  ];
  return lines.join("\n");
}

export function buildGroupStatsMessage(
  map: DateDrawsMapStats,
  diasDiferencia: number,
  period: StatsPeriod
): string {
  const { groups: stats } = computeStatsCombined(map, period);
  const W_NAME = 12;
  const W_MAX = 10;
  const W_ACT = 10;
  const W_HOT = 8;
  const isHot = (maxH: number, cur: number | null) => cur !== null && maxH - cur <= diasDiferencia;
  const fmt = (name: string, maxH: number, cur: number | null) => {
    const curStr = cur !== null ? String(cur) : "—";
    const hotStr = isHot(maxH, cur) ? "🔥 Hot" : cur !== null ? String(maxH - cur) : "—";
    return (
      name.padEnd(W_NAME) +
      String(maxH).padStart(W_MAX) +
      curStr.padStart(W_ACT) +
      hotStr.padStart(W_HOT)
    );
  };
  const sep = "─".repeat(W_NAME + W_MAX + W_ACT + W_HOT);
  const header =
    "Grupo".padEnd(W_NAME) +
    "Máx.hist".padStart(W_MAX) +
    "Máx.actual".padStart(W_ACT) +
    "Hot/diff".padStart(W_HOT);
  const lines: string[] = [
    `📊 *Estadísticas por grupos* — ${PERIOD_LABEL[period]} · Hot si (Máx.hist−Máx.actual) ≤ ${diasDiferencia}\n`,
    "```",
    header,
    sep,
  ];
  for (let k = 0; k < 10; k++) {
    const t = stats.terminales[k]!;
    lines.push(fmt(`Terminal ${k}`, t.maxGapDays, t.currentGapDays));
  }
  lines.push(sep);
  for (let k = 0; k < 10; k++) {
    const t = stats.iniciales[k]!;
    lines.push(fmt(`Inicial ${k}`, t.maxGapDays, t.currentGapDays));
  }
  lines.push(sep);
  lines.push(fmt("Dobles", stats.dobles.maxGapDays, stats.dobles.currentGapDays));
  lines.push("```");
  return lines.join("\n");
}
