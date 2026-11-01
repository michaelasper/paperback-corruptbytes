// JavaScriptCore has neither the browser's atob nor Node's Buffer. Newer entities
// tables decode base64 during module evaluation, before extension initialise().
// Install only the missing primitive; never replace a host implementation.
export const decodeBase64Binary = (input: string): string => {
  let encoded = input.replace(/[\t\n\f\r ]/g, "");
  if (encoded.length % 4 === 0) encoded = encoded.replace(/={1,2}$/, "");
  if (encoded.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(encoded)) {
    throw new Error("Invalid base64 input.");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let bits = 0;
  let accumulator = 0;
  let result = "";
  for (const character of encoded) {
    accumulator = (accumulator << 6) | alphabet.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result += String.fromCharCode((accumulator >>> bits) & 0xff);
    }
  }
  return result;
};

if (typeof globalThis.atob !== "function") {
  globalThis.atob = decodeBase64Binary;
}
