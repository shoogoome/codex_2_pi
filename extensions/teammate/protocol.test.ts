import { describe, it, expect } from "vitest";
import {
  buildShutdownRequest,
  buildShutdownResponse,
  parseShutdownRequest,
  parseShutdownResponse,
  detectProtocol,
  parseProtocol,
  type ProtocolBody,
} from "./protocol.js";

describe("protocol — shutdown_request build/parse round-trip", () => {
  it("builds + parses a shutdown_request", () => {
    const body = buildShutdownRequest("r-1");
    expect(JSON.parse(body)).toEqual({ type: "shutdown_request", request_id: "r-1" });
    expect(parseShutdownRequest(body)).toEqual({
      type: "shutdown_request",
      request_id: "r-1",
    });
  });
});

describe("protocol — shutdown_response build/parse round-trip", () => {
  it("round-trips shutdown_response with approve=true and no feedback", () => {
    const body = buildShutdownResponse("r-2", true);
    expect(JSON.parse(body)).toEqual({
      type: "shutdown_response",
      request_id: "r-2",
      approve: true,
    });
    expect(parseShutdownResponse(body)).toEqual({
      type: "shutdown_response",
      request_id: "r-2",
      approve: true,
    });
  });

  it("preserves feedback when approve=false", () => {
    const body = buildShutdownResponse("r-3", false, "still busy");
    expect(parseShutdownResponse(body)).toEqual({
      type: "shutdown_response",
      request_id: "r-3",
      approve: false,
      feedback: "still busy",
    });
  });
});

describe("protocol — parseShutdownRequest defensive validation", () => {
  it("rejects non-JSON, non-object, wrong type, missing/empty/non-string request_id", () => {
    expect(parseShutdownRequest("not json")).toBeUndefined();
    expect(parseShutdownRequest("")).toBeUndefined();
    expect(parseShutdownRequest("null")).toBeUndefined();
    expect(parseShutdownRequest('"string-body"')).toBeUndefined();
    expect(parseShutdownRequest('{"type":"other","request_id":"r-1"}')).toBeUndefined();
    expect(parseShutdownRequest('{"type":"shutdown_request"}')).toBeUndefined();
    expect(parseShutdownRequest('{"type":"shutdown_request","request_id":""}')).toBeUndefined();
    expect(parseShutdownRequest('{"type":"shutdown_request","request_id":42}')).toBeUndefined();
  });
});

describe("protocol — parseShutdownResponse defensive validation", () => {
  it("rejects non-JSON, non-object, wrong type, bad request_id, non-boolean approve, non-string feedback", () => {
    expect(parseShutdownResponse("not json")).toBeUndefined();
    expect(parseShutdownResponse("null")).toBeUndefined();
    expect(parseShutdownResponse('{"type":"other","request_id":"r","approve":true}')).toBeUndefined();
    expect(parseShutdownResponse('{"type":"shutdown_response","approve":true}')).toBeUndefined();
    expect(
      parseShutdownResponse('{"type":"shutdown_response","request_id":"","approve":true}'),
    ).toBeUndefined();
    expect(
      parseShutdownResponse('{"type":"shutdown_response","request_id":"r","approve":"yes"}'),
    ).toBeUndefined();
    expect(
      parseShutdownResponse('{"type":"shutdown_response","request_id":"r"}'),
    ).toBeUndefined();
    expect(
      parseShutdownResponse(
        '{"type":"shutdown_response","request_id":"r","approve":true,"feedback":123}',
      ),
    ).toBeUndefined();
  });
});

describe("protocol — detectProtocol kind discrimination", () => {
  it("returns the full kind string for a shutdown_request", () => {
    expect(detectProtocol(buildShutdownRequest("r"))).toBe("shutdown_request");
  });

  it("returns the full kind string for a shutdown_response", () => {
    expect(detectProtocol(buildShutdownResponse("r", true))).toBe("shutdown_response");
  });

  it("returns undefined for plain-text bodies", () => {
    expect(detectProtocol("hi there")).toBeUndefined();
    expect(detectProtocol("")).toBeUndefined();
  });

  it("returns undefined for unrelated JSON objects", () => {
    expect(detectProtocol('{"foo":"bar"}')).toBeUndefined();
    expect(detectProtocol('{"type":"plan_proposal"}')).toBeUndefined();
  });
});

describe("protocol — parseProtocol returns typed union", () => {
  it("returns a ShutdownRequest narrowable by `type`", () => {
    const parsed = parseProtocol(buildShutdownRequest("abc"));
    expect(parsed).toBeDefined();
    const body = parsed as ProtocolBody;
    expect(body.type).toBe("shutdown_request");
    if (body.type === "shutdown_request") {
      expect(body.request_id).toBe("abc");
    }
  });

  it("returns a ShutdownResponse narrowable by `type`", () => {
    const parsed = parseProtocol(buildShutdownResponse("xyz", false, "later"));
    expect(parsed).toBeDefined();
    const body = parsed as ProtocolBody;
    expect(body.type).toBe("shutdown_response");
    if (body.type === "shutdown_response") {
      expect(body.request_id).toBe("xyz");
      expect(body.approve).toBe(false);
      expect(body.feedback).toBe("later");
    }
  });

  it("returns undefined for unknown bodies", () => {
    expect(parseProtocol("plain")).toBeUndefined();
    expect(parseProtocol('{"type":"unknown"}')).toBeUndefined();
  });
});
