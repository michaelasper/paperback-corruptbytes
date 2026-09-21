import { load } from "cheerio";

const BASE = "https://www.mangaupdates.com";

const clean = (value) =>
  String(value ?? "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();

const groupIdFromHref = (href) => {
  if (typeof href !== "string") return undefined;
  const match = href.match(/\/group\/([^/?#]+)\/([^/?#]+)\/?/i);
  if (!match?.[1] || !match?.[2]) return undefined;
  return { id: match[1].trim(), slug: match[2].trim().toLowerCase() };
};

const externalDomain = (href) => {
  if (typeof href !== "string") return undefined;
  if (!/^https?:\/\//i.test(href)) return undefined;
  try {
    const host = new URL(href).hostname.toLowerCase().replace(/^\.+/, "");
    if (!host || host === "www.mangaupdates.com" || host === "mangaupdates.com") return undefined;
    return host;
  } catch {
    return undefined;
  }
};

export const parseGroupsList = (html, letter = "ALL") => {
  const $ = load(html);
  const groups = [];
  const seen = new Set();
  $(".group-list-module__Bk_oea__alt").each((_, element) => {
    const row = $(element);
    const link = row.find("a[href*='/group/']").first();
    const href = link.attr("href");
    const identity = groupIdFromHref(href);
    const name = clean(link.text());
    if (!identity || !name || seen.has(identity.id)) return;
    seen.add(identity.id);
    const cells = row.children("div");
    const active = clean($(cells.get(1)).text()).toLowerCase() === "yes";
    const contact = row.find("a[rel='nofollow']").first().attr("href");
    groups.push({
      id: identity.id,
      slug: identity.slug,
      name,
      active,
      letter,
      mangaUpdatesUrl: `${BASE}/group/${identity.id}/${identity.slug}`,
      contactUrl: typeof contact === "string" ? contact : undefined,
      contactDomain: externalDomain(contact),
    });
  });
  return groups;
};

export const parseGroupDetailLinks = (html) => {
  const $ = load(html);
  const links = new Set();
  $("a[href^='http']").each((_, element) => {
    const href = $(element).attr("href");
    const domain = externalDomain(href);
    if (domain) links.add(href);
  });
  return [...links];
};

export const summarizeContactDomains = (groups) => {
  const counts = new Map();
  for (const group of groups) {
    if (!group.contactDomain) continue;
    counts.set(group.contactDomain, (counts.get(group.contactDomain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((left, right) => right.count - left.count || left.domain.localeCompare(right.domain));
};

export const LETTERS = [
  "ALL",
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)),
];

export const groupsListUrl = (letter) =>
  letter === "ALL" ? `${BASE}/groups` : `${BASE}/groups?letter=${encodeURIComponent(letter)}`;
