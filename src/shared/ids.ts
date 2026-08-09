const URI_COMPONENT_PUNCTUATION = /[!'()*~]/g;
const ENCODED_PATH_DELIMITER = /%(?:2f|2e|5c|3f|23)/i;

const isUnicodeNoncharacter = (codePoint: number): boolean =>
  (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) >= 0xfffe;

export const DEFAULT_MAX_OPAQUE_ID_LENGTH = 256;

/**
 * Validate an opaque identifier without normalizing it.
 *
 * Source identifiers are data, not paths. Keeping this boundary deliberately
 * narrow prevents an ID accepted from an API response from later failing (or
 * changing meaning) when it is used in a request URL.
 */
export const validateOpaqueId = (
  value: unknown,
  maxLength = DEFAULT_MAX_OPAQUE_ID_LENGTH,
): string | undefined => {
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(maxLength) ||
    maxLength <= 0 ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    /\s/u.test(value) ||
    /[/?#\\]/u.test(value) ||
    ENCODED_PATH_DELIMITER.test(value) ||
    value === "." ||
    value === ".."
  ) {
    return undefined;
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      isUnicodeNoncharacter(codePoint)
    ) {
      return undefined;
    }
  }

  return value;
};

/**
 * Encode an opaque source identifier using only characters Paperback accepts.
 *
 * `encodeURIComponent` intentionally leaves a few URI punctuation characters
 * untouched. Paperback IDs have a narrower alphabet, so those characters must
 * be escaped explicitly. Existing alphanumeric, hyphenated IDs remain byte-for-
 * byte unchanged.
 */
export const encodePaperbackIdComponent = (value: string): string =>
  encodeURIComponent(value).replace(
    URI_COMPONENT_PUNCTUATION,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Decode an encoded component while remaining compatible with legacy IDs. */
export const decodePaperbackIdComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
