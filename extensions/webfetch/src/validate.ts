/**
 * URL validation (SSRF hardening) and redirect policy for webfetch.
 *
 * This is the security-critical core, ported from Claude Code's WebFetch but
 * WITHOUT the api.anthropic.com domain preflight (Anthropic-proprietary). In its
 * place we do fully local, offline checks that reject internal / loopback /
 * link-local / cloud-metadata / private-range destinations so the tool cannot be
 * abused as an SSRF pivot.
 *
 * Everything here is pure and synchronous — no network, so it unit-tests cleanly.
 */

/** Max URL length. Long JWT-signed URLs are legitimate, so keep this generous. */
export const MAX_URL_LENGTH = 2000;

/** Result of {@link checkUrl}: either an allow with the upgraded URL, or a reason. */
export type UrlCheck =
  | { ok: true; url: string; hostname: string }
  | { ok: false; reason: string };

/** Strip the surrounding brackets WHATWG URL keeps on IPv6 literal hosts. */
function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** True when every dot-separated group is a 0–255 integer (an IPv4 literal). */
function isIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  return m.slice(1).every((g) => {
    const n = Number(g);
    return n >= 0 && n <= 255;
  });
}

/**
 * Is this IPv4 literal in a private / reserved / loopback / metadata range?
 *   0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (incl. 169.254.169.254
 *   cloud metadata), 172.16/12, 192.168/16, 198.18/15 (benchmark), 224/4+ (multicast
 *   / reserved), 255.255.255.255 (broadcast).
 */
export function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this" network / 0.0.0.0
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

/**
 * Expand an IPv6 literal into exactly 8 16-bit groups, or null if it cannot be
 * parsed. Handles `::` compression and an embedded dotted-decimal IPv4 tail
 * (`::ffff:1.2.3.4`). Crucially, the WHATWG URL parser rewrites an IPv4-mapped
 * host to its HEX form (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`), so a naive
 * "dotted tail" check misses it entirely; expanding to groups lets us recover
 * the embedded IPv4 regardless of how the literal was written.
 */
function expandIpv6(host: string): number[] | null {
  let h = host.toLowerCase();
  if (h.length === 0) return null;
  // A trailing dotted-decimal IPv4 (…:1.2.3.4) → two hex groups.
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (dotted) {
    if (!isIpv4(dotted[2]!)) return null;
    const o = dotted[2]!.split(".").map(Number);
    const hi = ((o[0]! << 8) | o[1]!) & 0xffff;
    const lo = ((o[2]! << 8) | o[3]!) & 0xffff;
    h = `${dotted[1]!}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const dbl = h.split("::");
  if (dbl.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(Number.parseInt(g, 16));
    }
    return groups;
  };
  const head = parse(dbl[0]!);
  const tail = dbl.length === 2 ? parse(dbl[1]!) : [];
  if (head === null || tail === null) return null;
  let groups: number[];
  if (dbl.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  return groups.length === 8 ? groups : null;
}

/**
 * If these 8 IPv6 groups embed an IPv4 address in their low 32 bits under a
 * prefix that actually routes to that IPv4 — IPv4-mapped `::ffff:0:0/96`, the
 * deprecated IPv4-compatible `::/96`, or the NAT64 well-known prefix
 * `64:ff9b::/96` — return the embedded IPv4 in dotted-decimal; otherwise null.
 */
function embeddedIpv4(g: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const v4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
  const highZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (highZero && g5 === 0xffff) return v4; // ::ffff:0:0/96 IPv4-mapped
  if (highZero && g5 === 0) return v4; // ::/96 IPv4-compatible (deprecated, reserved)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4; // 64:ff9b::/96 NAT64
  return null;
}

/**
 * Is this IPv6 literal (unbracketed) loopback / unspecified / unique-local
 * (fc00::/7) / link-local (fe80::/10) / multicast (ff00::/8), or does it embed a
 * private IPv4 (mapped / compatible / NAT64)? Works on both the human dotted
 * form and the WHATWG hex-normalised form.
 */
export function isPrivateIpv6(host: string): boolean {
  const g = expandIpv6(unbracket(host));
  if (!g) {
    // Unparseable as a full IPv6 literal — fall back to conservative prefixes.
    const h = unbracket(host).toLowerCase();
    return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89abcdef]/.test(h) || /^ff/.test(h);
  }
  const [g0, g1, g2, g3, g4, g5, g6] = g as [number, number, number, number, number, number, number, number];
  const g7 = g[7]!;
  const allZeroHigh = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0;
  if (allZeroHigh && (g7 === 0 || g7 === 1)) return true; // :: unspecified / ::1 loopback
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  const v4 = embeddedIpv4(g);
  if (v4 && isIpv4(v4) && isPrivateIpv4(v4)) return true;
  return false;
}

/**
 * A hostname can smuggle a private IPv4 through public DNS via wildcard-resolver
 * services (127.0.0.1.nip.io, 10.0.0.1.sslip.io, …). Reject any host that has
 * four consecutive numeric labels forming a private IPv4. Public embedded IPs
 * (1.2.3.4.example.com) are left alone; only private/reserved quads are blocked,
 * so false positives are negligible.
 */
function hasEmbeddedPrivateIpv4(host: string): boolean {
  const labels = host.split(".");
  for (let i = 0; i + 4 <= labels.length; i++) {
    const quad = labels.slice(i, i + 4).join(".");
    if (isIpv4(quad) && isPrivateIpv4(quad)) return true;
  }
  return false;
}

/**
 * Reject a hostname if it targets an internal / non-public destination. Covers
 * DNS names (localhost, *.localhost, *.local), IPv4 literals, and IPv6 literals.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = unbracket(hostname).toLowerCase().replace(/\.$/, ""); // drop FQDN trailing dot
  if (host.length === 0) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true; // mDNS
  if (isIpv4(host)) return isPrivateIpv4(host);
  if (host.includes(":")) return isPrivateIpv6(host); // IPv6 literal
  if (hasEmbeddedPrivateIpv4(host)) return true; // e.g. 127.0.0.1.nip.io
  return false;
}

/**
 * True if `hostname` is an IP literal (IPv4 dotted-quad or an IPv6 literal,
 * bracketed or not) rather than a DNS name. Such hosts were already range-checked
 * by {@link isBlockedHost}, so the fetch pipeline skips DNS resolution for them.
 */
export function isIpLiteral(hostname: string): boolean {
  const h = unbracket(hostname).replace(/\.$/, "");
  return isIpv4(h) || h.includes(":");
}

/**
 * Classify a RESOLVED address (the concrete IP a DNS name resolved to) as
 * private / internal. This is the connect-time counterpart to {@link isBlockedHost}:
 * `isBlockedHost` guards the URL *string*, this guards the *resolved IP* so a
 * public-looking name that resolves to 169.254.169.254 / 127.0.0.1 / 10.x is
 * rejected. Anything not recognisable as an IP fails closed (returns true).
 */
export function isPrivateAddress(ip: string): boolean {
  const host = unbracket(ip).toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return true;
  if (isIpv4(host)) return isPrivateIpv4(host);
  if (host.includes(":")) return isPrivateIpv6(host);
  return true; // not a recognisable IP literal → refuse rather than guess
}

/**
 * Validate a URL for fetching. On success returns the (http→https upgraded) URL
 * and hostname. On failure returns a human-readable reason. Rules:
 *   - length ≤ 2000
 *   - must parse as a URL
 *   - protocol must be http/https (http is upgraded to https)
 *   - no embedded credentials (username/password)
 *   - not an internal/private/loopback/metadata host
 *   - DNS names must have at least two labels (publicly-resolvable heuristic)
 */
export function checkUrl(input: string): UrlCheck {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, reason: "URL is required" };
  }
  if (input.length > MAX_URL_LENGTH) {
    return { ok: false, reason: `URL exceeds ${MAX_URL_LENGTH} characters` };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: `could not parse URL: ${input}` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol} (only http/https allowed)` };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed" };
  }

  const rawHost = unbracket(parsed.hostname);
  if (!rawHost) {
    return { ok: false, reason: "URL has no hostname" };
  }

  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, reason: `refusing to fetch internal/private address: ${rawHost}` };
  }

  // For DNS names (not IP literals) require ≥2 labels so single-label internal
  // names ("intranet", "router") never resolve here. IP literals are exempt —
  // they were already range-checked above.
  const isIpLiteral = isIpv4(rawHost) || rawHost.includes(":");
  if (!isIpLiteral) {
    const labels = rawHost.replace(/\.$/, "").split(".");
    if (labels.length < 2) {
      return { ok: false, reason: `hostname is not publicly resolvable: ${rawHost}` };
    }
  }

  // Upgrade http → https. Keep the rest of the URL intact.
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }

  return { ok: true, url: parsed.toString(), hostname: parsed.hostname };
}

/**
 * Decide whether a redirect may be followed automatically. Only same-origin
 * redirects (same protocol, same port, no credentials, same host modulo a
 * leading `www.`) are auto-followed. The redirect target must ALSO pass the
 * private-host check — defence in depth against a public host 302-ing to an
 * internal address. Anything else must be surfaced to the caller, never chased.
 */
export function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  let original: URL;
  let redirect: URL;
  try {
    original = new URL(originalUrl);
    redirect = new URL(redirectUrl);
  } catch {
    return false;
  }

  if (redirect.protocol !== original.protocol) return false;
  if (redirect.port !== original.port) return false;
  if (redirect.username || redirect.password) return false;
  if (isBlockedHost(redirect.hostname)) return false;

  const stripWww = (h: string) => unbracket(h).toLowerCase().replace(/^www\./, "");
  return stripWww(original.hostname) === stripWww(redirect.hostname);
}
