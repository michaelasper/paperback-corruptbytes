import { URL as PaperbackURL } from "@paperback/types";

import { load } from "../shared/html-parser.js";
import { plainTextFromHtml, sanitizeChapterHtml } from "../shared/html.js";
import { extractNovelDashArrays, parseNovelDashFlight } from "../shared/noveldash-flight.js";
import { isHttpsUrlForHosts, resolveHttpsUrl } from "../shared/url.js";
import {
  PenguinAccessError,
  type ChapterAccess,
  type PenguinCatalogPage,
  type PenguinCard,
  type PenguinChapter,
  type PenguinChapterRef,
  type PenguinReader,
  type PenguinSeries,
  type SeriesId,
} from "./models.js";
import {
  DOMAIN,
  buildChapterUrl,
  buildSeriesUrl,
  encodeChapterId,
  encodeSeriesId,
  isChapterSlug,
  parseContinuation,
  parseSitePath,
  seriesSlugOf,
} from "./network.js";
import { COVER_HOSTS } from "./site.js";

type Document = ReturnType<typeof load>;

const STATUS_LABELS = new Set([
  "Ongoing",
  "Completed",
  "Hiatus",
  "Dropped",
  "Cancelled",
  "On Hold",
]);

const EMPTY_STATE = /\bno (?:novels?|results?)\b/i;
const GATE_HEADING = /\bunlock (?:this )?chapter\b|\bpremium chapters?\b|\bsubscriber-only\b/i;

const clean = (value: string | undefined | null): string =>
  (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const approvedCover = (value: unknown): string | undefined => {
  const url = resolveHttpsUrl(value, DOMAIN);
  return url && isHttpsUrlForHosts(url, COVER_HOSTS) ? url : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type PenguinCatalogRequest =
  | { readonly kind: "browse"; readonly page: number }
  | { readonly kind: "search"; readonly term: string; readonly page: number };

const catalogPageIdentity = ($: Document, request: PenguinCatalogRequest): void => {
  if (request.kind === "browse") {
    const heading = clean($("h1").first().text()).toLowerCase();
    if (!heading.includes("novels")) {
      throw new Error("Penguin Squad did not return the novel catalog.");
    }
    return;
  }
  const echo = clean($('form[action="/search"] input[name="q"]').first().attr("value"));
  if (echo !== request.term) {
    throw new Error("Penguin Squad did not return the requested search page.");
  }
};

export const parseCatalogPage = (
  html: string,
  request: PenguinCatalogRequest,
): PenguinCatalogPage => {
  const $ = load(html);
  catalogPageIdentity($, request);

  const seen = new Set<string>();
  const items: PenguinCard[] = [];
  $("a[href]").each((_, element) => {
    const anchor = $(element);
    if (anchor.closest("section").length > 0) return;
    const title = clean(anchor.find("h3").first().text());
    if (!title) return;
    const path = parseSitePath(anchor.attr("href"));
    if (!path || path.chapterSlug) return;
    const seriesId = encodeSeriesId(path.seriesSlug);
    if (seen.has(seriesId)) return;
    seen.add(seriesId);
    const cover = approvedCover(anchor.find("img").first().attr("src"));
    const genre = clean(anchor.find("p").first().text());
    items.push({
      seriesId,
      title,
      ...(cover && { coverUrl: cover }),
      ...(genre && genre.length <= 64 && { genre }),
      adult: anchor.find('[aria-label="Adult content"]').length > 0,
    });
  });

  if (items.length === 0) {
    const empty = $("div, p")
      .toArray()
      .some(
        (element) =>
          $(element).children().length === 0 && EMPTY_STATE.test(clean($(element).text())),
      );
    if (!empty) throw new Error("Penguin Squad returned no catalog cards.");
  }

  const nextLinks = $('a[aria-label="Go to next page"]');
  if (nextLinks.length > 1) throw new Error("Penguin Squad returned ambiguous pagination.");
  const nextHref = nextLinks.first().attr("href");
  if (nextHref === undefined) return { items };
  const next =
    request.kind === "search"
      ? parseContinuation(nextHref, { page: request.page, term: request.term })
      : parseContinuation(nextHref, { page: request.page });
  return next === undefined ? { items } : { items, next };
};

const chapterNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000_000
    ? value
    : undefined;

const publishedAt = (value: unknown): Date | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

interface SeriesRow {
  readonly slug: string;
  readonly number: number;
  readonly title: string;
  readonly access: ChapterAccess;
  readonly date?: Date;
}

const accessFrom = (value: unknown): ChapterAccess =>
  value === true ? { kind: "locked" } : value === false ? { kind: "public" } : { kind: "unknown" };

const rowsFrom = (value: unknown): SeriesRow[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Penguin Squad returned no chapter records.");
  }
  const rows: SeriesRow[] = [];
  const seen = new Map<string, SeriesRow>();
  for (const entry of value) {
    if (!isRecord(entry)) throw new Error("Penguin Squad returned a malformed chapter record.");
    const slug = entry["slug"];
    const number = chapterNumber(entry["chapter_number"]);
    const title = entry["title"];
    if (!isChapterSlug(slug) || number === undefined || typeof title !== "string") {
      throw new Error("Penguin Squad returned an incomplete chapter record.");
    }
    const access = accessFrom(entry["premium"]);
    const existing = seen.get(slug);
    if (existing) {
      if (existing.number !== number || existing.access.kind !== access.kind) {
        throw new Error("Penguin Squad returned conflicting chapter records.");
      }
      continue;
    }
    const date = publishedAt(entry["published_at"]);
    const row: SeriesRow = {
      slug,
      number,
      title: clean(title) || `Chapter ${number}`,
      access,
      ...(date && { date }),
    };
    seen.set(slug, row);
    rows.push(row);
  }
  return rows;
};

const declaredCounts = (stream: string): { premium: number; free: number } | undefined => {
  const values = (key: string): number[] => {
    const found: number[] = [];
    const pattern = new RegExp(`"${key}":(\\d{1,7})`, "g");
    let match = pattern.exec(stream);
    while (match?.[1] !== undefined) {
      found.push(Number(match[1]));
      match = pattern.exec(stream);
    }
    return found;
  };
  const premium = values("premiumCount");
  const free = values("freeChapterCount");
  if (premium.length === 0 && free.length === 0) return undefined;
  const distinct = (list: number[]): number | undefined =>
    list.length > 0 && list.every((value) => value === list[0]) ? list[0] : undefined;
  const premiumCount = distinct(premium);
  const freeCount = distinct(free);
  if (premiumCount === undefined || freeCount === undefined) {
    throw new Error("Penguin Squad returned conflicting chapter counts.");
  }
  return { premium: premiumCount, free: freeCount };
};

const jsonLd = ($: Document, type: string): Record<string, unknown> | undefined => {
  const entries = $('script[type="application/ld+json"]')
    .toArray()
    .flatMap((element): Record<string, unknown>[] => {
      try {
        const parsed = JSON.parse($(element).text()) as unknown;
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  return entries.find((entry) => entry["@type"] === type);
};

const namedRecord = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const name = clean(typeof value["name"] === "string" ? value["name"] : "");
  return name || undefined;
};

const headerIsAdult = ($: Document): boolean => {
  let node = $("h1").first();
  for (let depth = 0; depth < 3; depth += 1) {
    node = node.parent();
    if (node.length === 0) break;
    // Recommendation rails carry their own adult badges, so never widen the
    // search past a section boundary while looking for this series' badge.
    if (node.find("section").length > 0) continue;
    if (node.find('a[href*="genre="]').length > 0) {
      return node.find('[aria-label="Adult content"]').length > 0;
    }
  }
  return false;
};

export const parseSeries = (html: string, seriesId: SeriesId): PenguinSeries => {
  const $ = load(html);
  const seriesSlug = seriesSlugOf(seriesId);
  const seriesUrl = buildSeriesUrl(seriesId);

  const book = jsonLd($, "Book");
  const canonical = resolveHttpsUrl($('link[rel="canonical"]').attr("href"), DOMAIN);
  const bookUrl = resolveHttpsUrl(book?.["url"], DOMAIN);
  if (canonical === undefined && bookUrl === undefined) {
    throw new Error("Penguin Squad did not identify the requested series.");
  }
  if (
    (canonical !== undefined && canonical !== seriesUrl) ||
    (bookUrl !== undefined && bookUrl !== seriesUrl)
  ) {
    throw new Error("Penguin Squad returned a different series than requested.");
  }

  const document = parseNovelDashFlight(html);
  const arrays = extractNovelDashArrays<unknown>(document, "chapters").filter(
    (entry) => entry.length > 0,
  );
  if (arrays.length === 0) {
    throw new Error("Penguin Squad did not publish structured chapter records.");
  }
  const signature = (rows: readonly SeriesRow[]): string =>
    rows
      .map((row) => `${row.slug}:${row.access.kind}`)
      .sort()
      .join(",");
  const rows = rowsFrom(arrays[0]);
  const expected = signature(rows);
  for (const entry of arrays.slice(1)) {
    if (signature(rowsFrom(entry)) !== expected) {
      throw new Error("Penguin Squad published conflicting chapter records.");
    }
  }

  const links = new Set<string>();
  $("a[href]").each((_, element) => {
    const path = parseSitePath($(element).attr("href"));
    if (path?.chapterSlug && path.seriesSlug === seriesSlug) links.add(path.chapterSlug);
  });
  if (links.size !== rows.length || rows.some((row) => !links.has(row.slug))) {
    throw new Error("Penguin Squad chapter links did not match its chapter records.");
  }

  const counts = declaredCounts(document.stream);
  if (counts) {
    const premium = rows.filter((row) => row.access.kind === "locked").length;
    const unknown = rows.filter((row) => row.access.kind === "unknown").length;
    if (
      unknown > 0 ||
      counts.premium !== premium ||
      counts.free !== rows.length - premium ||
      counts.premium + counts.free !== rows.length
    ) {
      throw new Error("Penguin Squad published inconsistent chapter counts.");
    }
  }

  const title =
    clean(typeof book?.["name"] === "string" ? book["name"] : "") ||
    clean($("h1").first().text()) ||
    clean($('meta[property="og:title"]').attr("content"));
  if (!title) throw new Error("Penguin Squad series page did not contain a title.");

  const author = namedRecord(book?.["author"]);
  const translator = namedRecord(book?.["translator"]);
  const originalTitle = namedRecord(book?.["translationOfWork"]);
  const synopsis =
    clean($('meta[name="description"]').attr("content")) ||
    clean(
      typeof book?.["description"] === "string" ? plainTextFromHtml(book["description"]) : "",
    ) ||
    title;

  const tags = [
    ...new Set(
      $('a[href*="genre="]')
        .toArray()
        .map((element) => clean($(element).text()))
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));

  const status = $("span")
    .toArray()
    .map((element) => clean($(element).text()))
    .find((text) => STATUS_LABELS.has(text));

  const cover =
    approvedCover(typeof book?.["image"] === "string" ? book["image"] : undefined) ??
    approvedCover($('meta[property="og:image"]').attr("content"));

  return {
    seriesId,
    title,
    synopsis,
    authors: author ? [author] : [],
    ...(translator && { translator }),
    ...(originalTitle && { originalTitle }),
    tags,
    ...(status && { status }),
    ...(cover && { coverUrl: cover }),
    adult: headerIsAdult($),
    chapters: rows
      .map((row): PenguinChapter => ({
        chapterId: encodeChapterId(seriesSlug, row.slug),
        number: row.number,
        title: row.title,
        ...(row.date && { publishedAt: row.date }),
        access: row.access,
      }))
      .sort((left, right) => right.number - left.number || left.title.localeCompare(right.title)),
  };
};

const gateIsPresent = ($: Document, chapterPath: string): boolean => {
  let gated = false;
  $("a[href]").each((_, element) => {
    if (gated) return;
    const href = $(element).attr("href") ?? "";
    if (!/^\/(?:login|register)(?:[/?#]|$)/.test(href)) return;
    // A sign-in or registration call to action that returns to this chapter is
    // the site's own statement that the anonymous session cannot read it.
    try {
      if (decodeURIComponent(href).includes(chapterPath)) gated = true;
    } catch {
      gated = false;
    }
  });
  if (gated) return true;
  const heading = $("h2")
    .toArray()
    .filter((element) => $(element).closest(".reader-content").length === 0)
    .some((element) => GATE_HEADING.test(clean($(element).text())));
  if (heading) return true;
  const parentClass = String($(".reader-content").first().parent().attr("class") ?? "");
  return (
    /(?:^|\s)overflow-hidden(?:\s|$)/.test(parentClass) && /(?:^|\s)max-h-\d+/.test(parentClass)
  );
};

export const parseReader = (
  html: string,
  ref: PenguinChapterRef,
  chapter: { readonly number: number },
): PenguinReader => {
  const $ = load(html);
  const chapterUrl = buildChapterUrl(ref.chapterId);
  const readers = $(".reader-content");
  if (readers.length === 0) {
    throw new Error("Penguin Squad did not return readable chapter content.");
  }
  if (readers.length > 1) throw new Error("Penguin Squad returned ambiguous chapter content.");
  const reader = readers.first();

  if (gateIsPresent($, new PaperbackURL(chapterUrl).path)) throw new PenguinAccessError("locked");

  const canonical = resolveHttpsUrl($('link[rel="canonical"]').attr("href"), DOMAIN);
  if (canonical !== chapterUrl) {
    throw new Error("Penguin Squad returned a different chapter than requested.");
  }
  const identity = jsonLd($, "Chapter");
  if (identity) {
    const partOf = isRecord(identity["isPartOf"])
      ? resolveHttpsUrl(identity["isPartOf"]["url"], DOMAIN)
      : undefined;
    if (
      identity["position"] !== chapter.number ||
      resolveHttpsUrl(identity["url"], DOMAIN) !== chapterUrl ||
      (partOf !== undefined && partOf !== buildSeriesUrl(ref.seriesId))
    ) {
      throw new Error("Penguin Squad returned a different chapter than requested.");
    }
  }

  reader.find("img").each((_, element) => {
    if (!isHttpsUrlForHosts(resolveHttpsUrl($(element).attr("src"), DOMAIN) ?? "", COVER_HOSTS)) {
      $(element).remove();
    }
  });

  const raw = reader.html() ?? "";
  if (!plainTextFromHtml(raw) && reader.find("img").length === 0) {
    throw new Error("Penguin Squad chapter content was empty.");
  }
  return {
    seriesId: ref.seriesId,
    chapterId: ref.chapterId,
    html: sanitizeChapterHtml(raw, chapterUrl),
  };
};
