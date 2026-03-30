import { IDrawsProvider } from "../../domain/interfaces/IDrawsProvider.js";
import { DateDrawsMap } from "../../domain/models/Strategy.js";
import { loadDrawsFromDB } from "./PostgresDrawRepository.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos de caché

export class PostgresDrawProvider implements IDrawsProvider {
  private p3Cache: DateDrawsMap | null = null;
  private p4Cache: DateDrawsMap | null = null;
  private p3LastFetch = 0;
  private p4LastFetch = 0;

  async getP3Map(): Promise<DateDrawsMap> {
    const now = Date.now();
    if (this.p3Cache && now - this.p3LastFetch < CACHE_TTL_MS) {
      return this.p3Cache;
    }
    
    this.p3Cache = await loadDrawsFromDB("p3");
    this.p3LastFetch = now;
    return this.p3Cache;
  }

  async getP4Map(): Promise<DateDrawsMap> {
    const now = Date.now();
    if (this.p4Cache && now - this.p4LastFetch < CACHE_TTL_MS) {
      return this.p4Cache;
    }
    
    this.p4Cache = await loadDrawsFromDB("p4");
    this.p4LastFetch = now;
    return this.p4Cache;
  }

  async forceRefresh(): Promise<void> {
    this.p3Cache = null;
    this.p4Cache = null;
    this.p3LastFetch = 0;
    this.p4LastFetch = 0;
    await Promise.all([this.getP3Map(), this.getP4Map()]);
  }
}
