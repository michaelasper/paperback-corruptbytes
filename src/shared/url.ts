import { URL as PaperbackURL } from "@paperback/types";

const SCHEME = /^[a-z][a-z\d+.-]*:/i;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const protocol = (url: PaperbackURL): string => url.protocol.toLowerCase().replace(/:$/, "");

const isDefaultHttpsPort = (url: PaperbackURL): boolean => !url.port || url.port === "443";

const isHttp = (url: PaperbackURL): boolean => {
  const scheme = protocol(url);
  return (
    (scheme === "http" || scheme === "https") &&
    Boolean(url.hostname) &&
    !url.username &&
    !url.password
  );
};

const encodeUrl = (value: string): string => encodeURI(value).replace(/%25([\da-f]{2})/gi, "%$1");

const parseHttpUrl = (value: string): PaperbackURL | undefined => {
  try {
    const parsed = new PaperbackURL(encodeUrl(value));
    return isHttp(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const normalizePath = (value: string): string => {
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}${value.endsWith("/") && segments.length > 0 ? "/" : ""}`;
};

/** Resolve an absolute or relative URL while rejecting unsafe protocols and credentials. */
export const resolveHttpUrl = (value: unknown, base: string): string | undefined => {
  const raw = text(value);
  if (!raw) return undefined;
  if (SCHEME.test(raw) && !/^https?:/i.test(raw)) return undefined;
  if (
    !/^https?:\/\//i.test(raw) &&
    !raw.startsWith("//") &&
    !/^\.{0,2}\//.test(raw) &&
    /[\s\0]/.test(raw)
  ) {
    return undefined;
  }

  const parsedBase = parseHttpUrl(base);
  if (!parsedBase) return undefined;
  const authority = `${parsedBase.hostname}${parsedBase.port ? `:${parsedBase.port}` : ""}`;
  const origin = `${protocol(parsedBase)}://${authority}`;

  if (/^https?:\/\//i.test(raw)) return parseHttpUrl(raw)?.toString();
  if (raw.startsWith("//")) return parseHttpUrl(`${protocol(parsedBase)}:${raw}`)?.toString();
  if (raw.startsWith("?")) {
    return parseHttpUrl(`${origin}${parsedBase.path || "/"}${raw}`)?.toString();
  }
  if (raw.startsWith("#")) {
    return parseHttpUrl(`${parsedBase.toString().replace(/#.*$/, "")}${raw}`)?.toString();
  }

  const relativeMatch = raw.match(/^([^?#]*)([?#][\s\S]*)?$/);
  if (!relativeMatch) return undefined;
  const relativePath = relativeMatch[1] ?? "";
  const suffix = relativeMatch[2] ?? "";
  const basePath = parsedBase.path || "/";
  const directory = basePath.endsWith("/")
    ? basePath
    : basePath.slice(0, basePath.lastIndexOf("/") + 1);
  const path = normalizePath(
    relativePath.startsWith("/") ? relativePath : `${directory}${relativePath}`,
  );
  return parseHttpUrl(`${origin}${path}${suffix}`)?.toString();
};

/** Resolve a URL only when the final resource uses encrypted HTTPS transport. */
export const resolveHttpsUrl = (value: unknown, base: string): string | undefined => {
  const resolved = resolveHttpUrl(value, base);
  if (!resolved) return undefined;
  const parsed = parseHttpUrl(resolved);
  return parsed && protocol(parsed) === "https" ? parsed.toString() : undefined;
};

/** True only for HTTPS URLs whose hostname is explicitly allow-listed. */
export const isHttpsUrlForHosts = (value: string, allowedHosts: ReadonlySet<string>): boolean => {
  const parsed = parseHttpUrl(value);
  return (
    parsed !== undefined &&
    protocol(parsed) === "https" &&
    isDefaultHttpsPort(parsed) &&
    allowedHosts.has(parsed.hostname.toLowerCase())
  );
};

/** True only for HTTPS URLs at a domain apex or one of its real subdomains. */
export const isHttpsUrlForDomain = (value: string, domain: string): boolean => {
  const parsed = parseHttpUrl(value);
  if (!parsed || protocol(parsed) !== "https" || !isDefaultHttpsPort(parsed)) return false;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const expected = domain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  return Boolean(expected) && (hostname === expected || hostname.endsWith(`.${expected}`));
};

/** Extract the decoded final path component from a fully-qualified HTTP(S) URL. */
export const urlPathSlug = (value: string): string | undefined => {
  const parsed = parseHttpUrl(value);
  if (!parsed) return undefined;
  const segment = parsed.path.replace(/\/+$/, "").split("/").pop();
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};
