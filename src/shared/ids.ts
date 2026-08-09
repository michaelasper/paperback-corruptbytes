const URI_COMPONENT_PUNCTUATION = /[!'()*~]/g;

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
