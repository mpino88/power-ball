import { DateDrawsMap } from "../models/Strategy.js";

export interface ILotteryScraper {
  getP3Map(): Promise<DateDrawsMap>;
  getP4Map(): Promise<DateDrawsMap>;
  forceRefresh(): Promise<void>;
}
