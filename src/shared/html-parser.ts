// Dependency evaluation order matters: entities decodes its tables on import.
import "./runtime.js";

export { load } from "cheerio";
export type { Cheerio, CheerioAPI } from "cheerio";
