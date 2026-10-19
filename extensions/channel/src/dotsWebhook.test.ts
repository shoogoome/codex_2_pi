import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { lookup as dnsLookup } from "node:dns/promises";
import type { request as httpsRequest } from "node:https";
import { createDotsWebhookSender, decodeDotsSigningSecret, dotsCallbackUrl, dotsWebhookSignature, isPublicDotsAddress } from "./dotsWebhook.js";

const secret = `whsec_${Buffer.alloc(32, 42).toString("base64")}`;

describe("dots webhook security and signatures", () => {
  it("uses exact Standard Webhooks signed bytes and validates key encodings", () => {
    const body = '{"text":"你好"}';
    const expected = createHmac("sha256", Buffer.alloc(32, 42)).update(`evt_1.123.${body}`).digest("base64");
    expect(dotsWebhookSignature(secret, "evt_1", 123, body)).toBe(`v1,${expected}`);
    for (const invalid of ["abc", "whsec_?", `whsec_${Buffer.alloc(23).toString("base64")}`, `whsec_${Buffer.alloc(65).toString("base64")}`]) {
      expect(() => decodeDotsSigningSecret(invalid)).toThrow();
    }
  });

  it("blocks private, reserved, mapped IPv6 and transition destinations", () => {
    for (const ip of ["127.0.0.1", "10.1.1.1", "169.254.169.254", "172.16.1.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "192.0.2.1", "203.0.113.1", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fe80::1", "fd00::1", "2002:7f00:1::", "2001:db8::1", "2001::1", "3fff::1"]) {
      expect(isPublicDotsAddress(ip), ip).toBe(false);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) expect(isPublicDotsAddress(ip), ip).toBe(true);
    for (const url of ["http://public.example", "https://user:pass@public.example", "https://public.example/#fragment", "file:///x"]) expect(() => dotsCallbackUrl(url)).toThrow();
  });

  it("rejects mixed/public-private DNS answers before creating any socket", async () => {
    const request = vi.fn();
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    const send = createDotsWebhookSender({ lookup: lookup as unknown as typeof dnsLookup, request: request as unknown as typeof httpsRequest });
    await expect(send({ url: "https://receiver.example/hook", secrets: [secret], subscriptionId: "sub", id: "evt", payload: {} })).rejects.toThrow("not public");
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels a pending DNS lookup without creating a socket", async () => {
    const controller = new AbortController();
    const request = vi.fn();
    const lookup = vi.fn(() => new Promise(() => undefined));
    const send = createDotsWebhookSender({ lookup: lookup as unknown as typeof dnsLookup, request: request as unknown as typeof httpsRequest });
    const pending = send({ url: "https://receiver.example/hook", secrets: [secret], subscriptionId: "sub", id: "evt", payload: {}, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
  });

  it("pins validated DNS, preserves TLS hostname, bounds responses and never follows redirects", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    let captured: any;
    let written = "";
    const request = vi.fn((_url, options, callback) => {
      captured = options;
      const req = new EventEmitter() as EventEmitter & { end(body: string): void; destroy(error: Error): void };
      req.destroy = (error) => { queueMicrotask(() => req.emit("error", error)); };
      req.end = (body) => {
        written = body;
        queueMicrotask(() => {
          const res = new EventEmitter() as EventEmitter & { statusCode: number; destroy(): void };
          res.statusCode = 302;
          res.destroy = () => undefined;
          callback(res);
          res.emit("data", Buffer.from('{"challenge":"x"}'));
          res.emit("end");
        });
      };
      return req;
    });
    const send = createDotsWebhookSender({ lookup: lookup as unknown as typeof dnsLookup, request: request as unknown as typeof httpsRequest, now: () => 123_000 });
    const result = await send({ url: "https://receiver.example/hook", secrets: [secret], subscriptionId: "sub", id: "evt", payload: { text: "hello" } });
    expect(result.status).toBe(302);
    expect(request).toHaveBeenCalledOnce();
    expect(captured.servername).toBe("receiver.example");
    const cb = vi.fn(); captured.lookup("receiver.example", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(captured.headers["webhook-signature"]).toBe(dotsWebhookSignature(secret, "evt", 123, written));
    expect(captured.headers["X-MCP-Subscription-Id"]).toBe("sub");
    await send({ url: "https://receiver.example/hook", secrets: [secret], subscriptionId: "sub", id: "evt", payload: {} });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
