import { describe, expect, it } from "vitest";
import {
  checkUrl,
  isBlockedHost,
  isIpLiteral,
  isPermittedRedirect,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
} from "./validate.js";

describe("checkUrl — SSRF allow list", () => {
  it("allows a normal public https URL", () => {
    const r = checkUrl("https://example.com/docs?q=1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe("https://example.com/docs?q=1");
      expect(r.hostname).toBe("example.com");
    }
  });

  it("upgrades http to https", () => {
    const r = checkUrl("http://example.com/path");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://example.com/path");
  });

  it("allows a public IPv4 literal", () => {
    expect(checkUrl("https://8.8.8.8/").ok).toBe(true);
  });

  it("allows a public IPv6 literal", () => {
    expect(checkUrl("https://[2606:4700:4700::1111]/").ok).toBe(true);
  });
});

describe("checkUrl — rejections", () => {
  it("rejects URLs longer than 2000 chars", () => {
    const long = `https://example.com/${"a".repeat(2100)}`;
    const r = checkUrl(long);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/2000/);
  });

  it("rejects unparseable input", () => {
    expect(checkUrl("not a url").ok).toBe(false);
  });

  it("rejects non-http protocols", () => {
    expect(checkUrl("file:///etc/passwd").ok).toBe(false);
    expect(checkUrl("ftp://example.com/x").ok).toBe(false);
    expect(checkUrl("data:text/html,<h1>x</h1>").ok).toBe(false);
  });

  it("rejects embedded credentials", () => {
    const r = checkUrl("https://user:pass@example.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/credentials/);
  });

  it("rejects single-label / non-resolvable hostnames", () => {
    expect(checkUrl("https://intranet/").ok).toBe(false);
    expect(checkUrl("https://localhost/").ok).toBe(false);
  });

  it.each([
    ["https://localhost/", "localhost"],
    ["https://foo.localhost/", "*.localhost"],
    ["https://printer.local/", "*.local"],
    ["https://127.0.0.1/", "loopback"],
    ["https://127.5.5.5/", "loopback range"],
    ["https://0.0.0.0/", "unspecified"],
    ["https://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["https://10.0.0.5/", "10/8"],
    ["https://172.16.0.1/", "172.16/12"],
    ["https://172.31.255.255/", "172.16/12 upper"],
    ["https://192.168.1.1/", "192.168/16"],
    ["https://100.64.0.1/", "CGNAT"],
    ["https://[::1]/", "ipv6 loopback"],
    ["https://[fc00::1]/", "ipv6 ULA"],
    ["https://[fe80::1]/", "ipv6 link-local"],
  ])("rejects internal/private address %s (%s)", (url) => {
    expect(checkUrl(url).ok).toBe(false);
  });

  // Numeric / alternate-encoding IP literals. WHATWG URL normalises these to
  // dotted-decimal (decimal/hex/octal) or hex-grouped IPv6 before we ever see the
  // hostname, so the range checks must still fire. Regression guard against a
  // future parser change or a hand-rolled host extractor reintroducing a bypass.
  it.each([
    ["http://2130706433/", "decimal 127.0.0.1"],
    ["http://0x7f000001/", "hex 127.0.0.1"],
    ["http://0177.0.0.1/", "octal 127.x"],
    ["http://0x7f.0.0.1/", "mixed hex/dotted"],
    ["http://0/", "bare 0 → 0.0.0.0"],
    ["http://0xA9FEA9FE/", "hex 169.254.169.254 (metadata)"],
    ["http://2852039166/", "decimal 169.254.169.254 (metadata)"],
    ["http://[::ffff:127.0.0.1]/", "ipv4-mapped v6 (dotted)"],
    ["http://[::ffff:7f00:1]/", "ipv4-mapped v6 (hex form)"],
    ["http://[::ffff:169.254.169.254]/", "ipv4-mapped metadata"],
    ["http://[::ffff:a9fe:a9fe]/", "ipv4-mapped metadata (hex)"],
    ["http://[64:ff9b::7f00:1]/", "NAT64 → 127.0.0.1"],
    ["http://[::]/", "ipv6 unspecified"],
    ["http://[fec0::1]/", "ipv6 deprecated site-local"],
    ["http://127.0.0.1./", "trailing-dot loopback"],
    ["http://LOCALHOST./", "upper-case trailing-dot localhost"],
  ])("rejects alternate-encoding internal address %s (%s)", (url) => {
    expect(checkUrl(url).ok).toBe(false);
  });

  it("rejects user-info that masks an internal host", () => {
    // http://expected@169.254.169.254/ — the real host is the metadata service.
    expect(checkUrl("http://expected@169.254.169.254/").ok).toBe(false);
  });

  it("still allows genuinely public alternate encodings", () => {
    expect(checkUrl("http://[::ffff:8.8.8.8]/").ok).toBe(true); // public v4-mapped
    expect(checkUrl("http://[2606:4700:4700::1111]/").ok).toBe(true);
  });
});

describe("isPrivateIpv4 / isPrivateIpv6 / isBlockedHost", () => {
  it("classifies IPv4 ranges", () => {
    expect(isPrivateIpv4("169.254.169.254")).toBe(true);
    expect(isPrivateIpv4("172.15.0.1")).toBe(false); // just below the private block
    expect(isPrivateIpv4("172.32.0.1")).toBe(false); // just above
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
  });

  it("classifies IPv6 ranges incl. IPv4-mapped", () => {
    expect(isPrivateIpv6("::1")).toBe(true);
    expect(isPrivateIpv6("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIpv6("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIpv6("2606:4700::1")).toBe(false);
  });

  it("blocks by hostname text", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("db.local")).toBe(true);
    expect(isBlockedHost("[::1]")).toBe(true);
    expect(isBlockedHost("example.com")).toBe(false);
  });

  it("classifies deprecated IPv6 site-local (fec0::/10)", () => {
    expect(isPrivateIpv6("fec0::1")).toBe(true);
    expect(isPrivateIpv6("feff::1")).toBe(true);
  });
});

describe("isIpLiteral", () => {
  it("recognises IPv4 and IPv6 literals (bracketed or not, trailing dot ok)", () => {
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("8.8.8.8.")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral("2606:4700::1")).toBe(true);
  });
  it("treats DNS names as non-literals (they need resolving)", () => {
    expect(isIpLiteral("example.com")).toBe(false);
    expect(isIpLiteral("metadata.attacker.com")).toBe(false);
  });
});

describe("isPrivateAddress — resolved-IP classification (DNS SSRF guard)", () => {
  it("flags resolved internal IPv4/IPv6", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe(true); // cloud metadata
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
  });
  it("passes genuinely public IPs", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
  it("fails closed on garbage / non-IP answers", () => {
    expect(isPrivateAddress("")).toBe(true);
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("isPermittedRedirect", () => {
  it("follows same-host path change", () => {
    expect(isPermittedRedirect("https://example.com/a", "https://example.com/b")).toBe(true);
  });

  it("follows www add/remove", () => {
    expect(isPermittedRedirect("https://example.com/", "https://www.example.com/")).toBe(true);
    expect(isPermittedRedirect("https://www.example.com/", "https://example.com/")).toBe(true);
  });

  it("does not follow cross-host redirects", () => {
    expect(isPermittedRedirect("https://example.com/", "https://evil.com/")).toBe(false);
  });

  it("does not follow protocol downgrade or port change", () => {
    expect(isPermittedRedirect("https://example.com/", "http://example.com/")).toBe(false);
    expect(isPermittedRedirect("https://example.com/", "https://example.com:8443/")).toBe(false);
  });

  it("does not follow redirect that adds credentials", () => {
    expect(isPermittedRedirect("https://example.com/", "https://u:p@example.com/")).toBe(false);
  });

  it("does not follow same-host redirect to an internal address", () => {
    // A same-label trick can't reach here, but a redirect to a private host is refused.
    expect(isPermittedRedirect("https://example.com/", "https://127.0.0.1/")).toBe(false);
  });
});
