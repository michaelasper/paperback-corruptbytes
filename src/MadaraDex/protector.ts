import type { CheerioAPI } from "cheerio";

const SELECTOR = "#chapter-protector-data";
const DATA_URI_PREFIX = "data:text/javascript;base64,";

const bufferOf = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const hexToBytes = (value: string): Uint8Array => {
  const hex = value.trim();
  if (!hex || hex.length % 2 !== 0 || !/^[\da-f]+$/i.test(hex)) {
    throw new Error("Invalid hexadecimal data.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const decodedBase64 = (value: string): Uint8Array => {
  const decoded = Application.base64Decode(value.trim());
  if (typeof decoded === "string") {
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }
  return new Uint8Array(decoded);
};

const utf8 = (value: Uint8Array): string => {
  try {
    return Application.arrayBufferToUTF8String(bufferOf(value));
  } catch {
    return new TextDecoder().decode(value);
  }
};

const md5 = (value: Uint8Array): Uint8Array =>
  hexToBytes(Application.crypto_md5Hash(bufferOf(value)));

const deriveKeyAndIv = (
  passphrase: string,
  salt: Uint8Array,
): { key: Uint8Array; iv: Uint8Array } => {
  const password = new TextEncoder().encode(passphrase);
  const material = new Uint8Array(48);
  let previous = new Uint8Array(0);
  let offset = 0;
  while (offset < material.length) {
    const input = new Uint8Array(previous.length + password.length + salt.length);
    input.set(previous);
    input.set(password, previous.length);
    input.set(salt, previous.length + password.length);
    previous = new Uint8Array(md5(input));
    material.set(previous, offset);
    offset += previous.length;
  }
  return { key: material.slice(0, 32), iv: material.slice(32, 48) };
};

const variablesFrom = (script: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const singleQuoted = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*'((?:\\.|[^'\\])*)'\s*;/g;
  const doubleQuoted = /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*"((?:\\.|[^"\\])*)"\s*;/g;
  for (const expression of [singleQuoted, doubleQuoted]) {
    let match: RegExpExecArray | null;
    while ((match = expression.exec(script)) !== null) {
      if (match[1] && match[2] !== undefined) result[match[1]] = match[2];
    }
  }
  return result;
};

const decryptPayload = async (payloadText: string, passphrase: string): Promise<string[]> => {
  const payload = JSON.parse(payloadText.replace(/\\\//g, "/")) as Record<string, unknown>;
  if (
    typeof payload.ct !== "string" ||
    typeof payload.s !== "string" ||
    (payload.iv !== undefined && typeof payload.iv !== "string")
  ) {
    throw new Error("Missing ciphertext parameters.");
  }
  const derived = deriveKeyAndIv(passphrase, hexToBytes(payload.s));
  const iv = payload.iv ? hexToBytes(payload.iv) : derived.iv;
  if (iv.length !== 16) throw new Error("Invalid AES initialization vector.");
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    bufferOf(derived.key),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: "AES-CBC", iv: bufferOf(iv) },
    cryptoKey,
    bufferOf(decodedBase64(payload.ct)),
  );
  let decoded: unknown = JSON.parse(utf8(new Uint8Array(plaintext)));
  if (typeof decoded === "string") decoded = JSON.parse(decoded);
  if (!Array.isArray(decoded) || !decoded.every((value) => typeof value === "string")) {
    throw new Error("Decrypted value was not an image array.");
  }
  return decoded;
};

/** Returns null when a chapter uses ordinary inline reader markup. */
export const decryptProtectedPages = async ($: CheerioAPI): Promise<string[] | null> => {
  const element = $(SELECTOR).first();
  if (element.length === 0) return null;
  try {
    const source = element.attr("src")?.trim() ?? "";
    const script = source.startsWith(DATA_URI_PREFIX)
      ? utf8(decodedBase64(source.slice(DATA_URI_PREFIX.length)))
      : (element.html() ?? element.text());
    const variables = variablesFrom(script);
    const passphrase = variables.wpmangaprotectornonce;
    const payload = variables.chapter_data;
    if (!passphrase || !payload) throw new Error("Missing protector variables.");
    return await decryptPayload(payload, passphrase.replace(/\\'/g, "'").replace(/\\\\/g, "\\"));
  } catch (error: unknown) {
    throw new Error("MadaraDex chapter protector could not be decrypted.", { cause: error });
  }
};
