import { AsyncKeyedCache } from "../shared/async-cache.js";
import type {
  PenguinCatalogPage,
  PenguinChapterRef,
  PenguinReader,
  PenguinSeries,
  SeriesId,
} from "./models.js";
import { PenguinAccessError } from "./models.js";
import {
  buildCatalogUrl,
  buildChapterUrl,
  buildSearchUrl,
  buildSeriesUrl,
  decodeSeriesId,
  fetchText as fetchSiteText,
  normalizePageNumber,
  normalizeSearchTerm,
  parsePastedUrl,
} from "./network.js";
import { parseCatalogPage, parseReader, parseSeries } from "./parsers.js";

/** Fetch a first-party document. Injectable so tests never touch the network. */
export type PenguinTransport = (url: string) => Promise<string>;

const SERIES_CACHE_TTL_MS = 60_000;
const CATALOG_CACHE_TTL_MS = 60_000;

export class PenguinClient {
  private readonly seriesCache = new AsyncKeyedCache<string, PenguinSeries>({
    ttlMs: SERIES_CACHE_TTL_MS,
    maxEntries: 16,
  });
  private readonly catalogCache = new AsyncKeyedCache<string, PenguinCatalogPage>({
    ttlMs: CATALOG_CACHE_TTL_MS,
    maxEntries: 64,
  });

  constructor(private readonly transport: PenguinTransport = fetchSiteText) {}

  async getCatalogPage(page: number): Promise<PenguinCatalogPage> {
    const current = normalizePageNumber(page);
    const url = buildCatalogUrl(current);
    return this.catalogCache.get(url, async () =>
      parseCatalogPage(await this.transport(url), { kind: "browse", page: current }),
    );
  }

  async search(term: string): Promise<PenguinCatalogPage> {
    const normalized = normalizeSearchTerm(term);
    const url = buildSearchUrl(normalized);
    return this.catalogCache.get(url, async () =>
      parseCatalogPage(await this.transport(url), {
        kind: "search",
        term: normalized,
        page: 1,
      }),
    );
  }

  async getSeries(seriesId: SeriesId): Promise<PenguinSeries> {
    const key = decodeSeriesId(seriesId);
    return this.seriesCache.get(key, async () =>
      parseSeries(await this.transport(buildSeriesUrl(seriesId)), seriesId),
    );
  }

  /**
   * Read a chapter only after re-reading the series records, because access can
   * change between listing a chapter and opening it. A cached public record is
   * never enough to authorize a read.
   */
  async read(ref: PenguinChapterRef): Promise<PenguinReader> {
    this.seriesCache.delete(decodeSeriesId(ref.seriesId));
    const series = await this.getSeries(ref.seriesId);
    const chapter = series.chapters.find((entry) => entry.chapterId === ref.chapterId);
    if (!chapter) {
      throw new Error("Penguin Squad chapter does not belong to this series.");
    }
    if (chapter.access.kind !== "public") {
      throw new PenguinAccessError(chapter.access.kind);
    }
    const html = await this.transport(buildChapterUrl(ref.chapterId));
    return parseReader(html, ref, chapter);
  }

  async resolvePastedUrl(value: string): Promise<PenguinSeries | undefined> {
    const seriesId = parsePastedUrl(value);
    return seriesId ? this.getSeries(seriesId) : undefined;
  }

  invalidateCaches(): void {
    this.seriesCache.clear();
    this.catalogCache.clear();
  }
}
