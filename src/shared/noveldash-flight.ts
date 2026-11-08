import { utf8ByteLength } from "./async-cache.js";
import { load } from "./html-parser.js";

export interface NovelDashFlightDocument {
  stream: string;
  textReferences: ReadonlyMap<string, string>;
}

const FLIGHT_PUSH_PREFIX = "self.__next_f.push(";
const TEXT_RECORD = /^([\da-f]+):T([\da-f]+),/i;

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

export const parseNovelDashFlight = (html: string): NovelDashFlightDocument => {
  const rawStream = flightChunks(html).join("");
  if (!rawStream) throw new Error("The page did not contain a readable Next.js data stream.");

  const records: string[] = [];
  const textReferences = new Map<string, string>();
  let offset = 0;
  while (offset < rawStream.length) {
    const remaining = rawStream.slice(offset);
    if (!/^[\da-f]+:T/i.test(remaining)) {
      const newline = rawStream.indexOf("\n", offset);
      const end = newline < 0 ? rawStream.length : newline + 1;
      records.push(rawStream.slice(offset, end));
      offset = end;
      continue;
    }

    const header = TEXT_RECORD.exec(remaining);
    const id = header?.[1]?.toLowerCase();
    const expectedBytes = Number.parseInt(header?.[2] ?? "", 16);
    if (!header || !id || !Number.isSafeInteger(expectedBytes)) {
      throw new Error("The page contained an invalid Next.js text record.");
    }
    offset += header[0].length;
    const value = utf8Prefix(rawStream.slice(offset), expectedBytes);
    if (value.bytes !== expectedBytes) {
      throw new Error("The page contained an incomplete Next.js text record.");
    }
    textReferences.set(id, value.text);
    records.push("\0");
    offset += value.text.length;
  }
  return { stream: records.join(""), textReferences };
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
