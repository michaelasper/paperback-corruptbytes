import { load } from "cheerio";

import { utf8ByteLength } from "./async-cache.js";

export interface NovelDashFlightDocument {
  stream: string;
  textReferences: ReadonlyMap<string, string>;
}

const FLIGHT_PUSH_PREFIX = "self.__next_f.push(";
const TEXT_RECORD = /(?:^|\n)([\da-f]+):T([\da-f]+),/gi;

const flightChunks = (html: string): string[] => {
  const $ = load(html);
  return $("script:not([src])")
    .toArray()
    .flatMap((element): string[] => {
      const source = $(element).text();
      if (!source.startsWith(FLIGHT_PUSH_PREFIX) || !source.endsWith(")")) return [];
      try {
        const value = JSON.parse(source.slice(FLIGHT_PUSH_PREFIX.length, -1)) as unknown;
        return Array.isArray(value) && typeof value[1] === "string" ? [value[1]] : [];
      } catch {
        return [];
      }
    });
};

const utf8Prefix = (value: string, maximumBytes: number): { bytes: number; text: string } => {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    bytes += characterBytes;
    end += character.length;
    if (bytes === maximumBytes) break;
  }
  return { bytes, text: value.slice(0, end) };
};

const textReferencesFrom = (stream: string): ReadonlyMap<string, string> => {
  const references = new Map<string, string>();
  TEXT_RECORD.lastIndex = 0;
  for (let match = TEXT_RECORD.exec(stream); match; match = TEXT_RECORD.exec(stream)) {
    const id = match[1]?.toLowerCase();
    const expectedBytes = Number.parseInt(match[2] ?? "", 16);
    if (!id || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) continue;
    const value = utf8Prefix(stream.slice(TEXT_RECORD.lastIndex), expectedBytes);
    if (value.bytes === expectedBytes) {
      references.set(id, value.text);
      TEXT_RECORD.lastIndex += value.text.length;
    }
  }
  return references;
};

export const parseNovelDashFlight = (html: string): NovelDashFlightDocument => {
  const stream = flightChunks(html).join("");
  if (!stream) throw new Error("The page did not contain a readable Next.js data stream.");
  return { stream, textReferences: textReferencesFrom(stream) };
};

const balancedJson = (source: string, start: number): string | undefined => {
  const opening = source[start];
  if (opening !== "{" && opening !== "[") return undefined;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
};

export const extractNovelDashObject = <T>(document: NovelDashFlightDocument, marker: string): T => {
  let offset = 0;
  while (offset < document.stream.length) {
    const start = document.stream.indexOf(marker, offset);
    if (start < 0) break;
    const raw = balancedJson(document.stream, start);
    if (raw) {
      try {
        return JSON.parse(raw) as T;
      } catch {
        // A later record may contain the same marker and a complete object.
      }
    }
    offset = start + marker.length;
  }
  throw new Error("The page did not contain the expected structured data.");
};

export const extractNovelDashArrays = <T>(
  document: NovelDashFlightDocument,
  key: string,
): T[][] => {
  const marker = `${JSON.stringify(key)}:[`;
  const arrays: T[][] = [];
  let offset = 0;
  while (offset < document.stream.length) {
    const markerStart = document.stream.indexOf(marker, offset);
    if (markerStart < 0) break;
    const start = markerStart + marker.length - 1;
    const raw = balancedJson(document.stream, start);
    if (raw) {
      try {
        const value = JSON.parse(raw) as unknown;
        if (Array.isArray(value)) arrays.push(value as T[]);
      } catch {
        // Keep looking for another complete occurrence.
      }
    }
    offset = start + 1;
  }
  return arrays;
};

export const resolveNovelDashFlightString = (
  value: unknown,
  document: NovelDashFlightDocument,
): string | undefined => {
  if (typeof value !== "string") return undefined;
  const reference = value.match(/^\$([\da-f]+)$/i)?.[1]?.toLowerCase();
  return reference ? document.textReferences.get(reference) : value;
};
