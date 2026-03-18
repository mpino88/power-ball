export interface DateDrawsMap {
  [date: string]: {
    m?: number[];
    e?: number[];
  };
}

export function buildRecentDrawsDisplay(
  p3Map: DateDrawsMap,
  p4Map: DateDrawsMap,
  today: string,
  yesterday: string
): string {
  // Encontrar el último Mediodía
  let mDate = today;
  let p3_m = p3Map[today]?.m;
  let p4_m = p4Map[today]?.m;
  if (!p3_m && !p4_m) {
    mDate = yesterday;
    p3_m = p3Map[yesterday]?.m;
    p4_m = p4Map[yesterday]?.m;
  }

  // Encontrar la última Noche
  let eDate = today;
  let p3_e = p3Map[today]?.e;
  let p4_e = p4Map[today]?.e;
  if (!p3_e && !p4_e) {
    eDate = yesterday;
    p3_e = p3Map[yesterday]?.e;
    p4_e = p4Map[yesterday]?.e;
    // Si tampoco está en yesterday, podría ser el día antepasado, pero ayer es el fallback seguro.
  }

  const formatP3 = (draw?: number[]) => draw ? draw.join("-") : "N/A";
  const formatP4 = (draw?: number[]) => draw ? draw.join("-") : "N/A";

  return `☀️🌙 Ultimos sorteos 🎰\n\n` +
    `☀️ Mediodía ${mDate}\n` +
    ` 🎯 Pick3 (Fijo): ${formatP3(p3_m)}\n` +
    `🎲 Pick4 (Corrido): ${formatP4(p4_m)}\n\n` +
    `🌙 Noche ${eDate}\n` +
    ` 🎯 Pick3 (Fijo): ${formatP3(p3_e)}\n` +
    `🎲 Pick4 (Corrido): ${formatP4(p4_e)}`;
}
