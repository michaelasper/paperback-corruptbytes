import { ContentRating } from "@paperback/types";
import { load } from "cheerio";

import { resolveHttpsUrl } from "./url.js";

const BLOCK_TAG =
  /<(?:\/)?(?:address|article|blockquote|div|h[1-6]|li|p|pre|section|tr|ul|ol)\b[^>]*>/gi;
const DROP_WITH_CONTENT =
  "script, style, iframe, object, embed, form, base, link, meta, svg, math, template";
const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);
const GLOBAL_ATTRIBUTES = new Set(["dir", "lang", "title"]);
const TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href"]),
  img: new Set(["alt", "height", "src", "width"]),
  ol: new Set(["start"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
};

const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Strip markup while retaining paragraph boundaries and decoding entities. */
export const plainTextFromHtml = (value: string): string => {
  if (!value) return "";
  const normalized = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(BLOCK_TAG, (tag) => (tag.startsWith("</") ? `${tag}\n\n` : tag));
  const $ = load(`<div>${normalized}</div>`, null, false);
  return $("div")
    .first()
    .text()
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const isXmlSafeCodePoint = (codePoint: number): boolean => {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return true;
  if (codePoint < 0x20 || codePoint > 0x10ffff) return false;
  if (codePoint >= 0x7f && codePoint <= 0x9f) return false;
  if (codePoint >= 0xfdd0 && codePoint <= 0xfdef) return false;
  if ((codePoint & 0xffff) >= 0xfffe) return false;
  return codePoint <= 0xd7ff || codePoint >= 0xe000;
};

const xmlSafeText = (value: string): string => {
  let result = "";
  for (const character of value) {
    if (isXmlSafeCodePoint(character.codePointAt(0)!)) result += character;
  }
  return result;
};

const escapeXmlText = (value: string): string =>
  xmlSafeText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/** Render trusted API structure while treating every paragraph value as inert text. */
export const paragraphsToXhtml = (paragraphs: readonly string[]): string => {
  const body = paragraphs
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeXmlText(paragraph).replace(/\r?\n/g, "<br />")}</p>`)
    .join("");
  return `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${body}</body></html>`;
};

/**
 * Produce self-contained XHTML for Paperback's novel reader using a small,
 * explicit element/attribute allow-list.
 */
export const sanitizeChapterHtml = (content: string, baseUrl: string): string => {
  const $ = load(content, null, false);
  $(DROP_WITH_CONTENT).remove();

  $("*").each((_, element) => {
    if (!("tagName" in element)) return;
    const tagName = element.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) {
      $(element).replaceWith($(element).contents());
      return;
    }

    const allowedForTag = TAG_ATTRIBUTES[tagName] ?? new Set<string>();
    for (const attribute of Object.keys(element.attribs ?? {})) {
      const normalized = attribute.toLowerCase();
      if (!GLOBAL_ATTRIBUTES.has(normalized) && !allowedForTag.has(normalized)) {
        $(element).removeAttr(attribute);
        continue;
      }

      if (normalized === "href" || normalized === "src") {
        const raw = asText(element.attribs?.[attribute]);
        const safe =
          normalized === "href" && raw?.startsWith("#") ? raw : resolveHttpsUrl(raw, baseUrl);
        if (safe) $(element).attr(attribute, safe);
        else $(element).removeAttr(attribute);
      }
    }
  });

  const body = $("body").length ? ($("body").html() ?? "") : ($.root().html() ?? "");
  return xmlSafeText(
    `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${body.trim()}</body></html>`,
  );
};

/** Derive a conservative Paperback rating from source-provided taxonomy. */
export const contentRatingForTags = (tags: readonly string[]): ContentRating => {
  const normalized = tags.map((tag) => tag.trim().toLowerCase());
  if (
    normalized.some((tag) =>
      /\b(?:adult|hentai|porn(?:ographic)?|shotacon|smut|yaoi|yuri)\b/.test(tag),
    )
  ) {
    return ContentRating.ADULT;
  }
  if (normalized.some((tag) => /\b(?:ecchi|gore|mature|nsfw|violence|violent)\b/.test(tag))) {
    return ContentRating.MATURE;
  }
  return ContentRating.EVERYONE;
};
