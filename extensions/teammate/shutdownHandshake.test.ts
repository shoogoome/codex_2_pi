import { describe, it, expect } from "vitest";
import {
  buildShutdownRequest,
  buildShutdownResponse,
  parseShutdownRequest,
  parseShutdownResponse,
  detectShutdownProtocol,
} from "./shutdownHandshake.js";

describe("shutdown handshake — builders", () => {
  it("buildShutdownRequest yields valid request JSON", () => {
    const body = buildShutdownRequest("r-1");
    expect(JSON.parse(body)).toEqual({ type: "shutdown_request", request_id: "r-1" });
  });

  it("buildShutdownResponse with approve=true and no feedback omits feedback field", () => {
    const body = buildShutdownResponse("r-2", true);
    expect(JSON.parse(body)).toEqual({
      type: "shutdown_response",
      request_id: "r-2",
      approve: true,
    });
  });

  it("buildShutdownResponse includes feedback when provided", () => {
    const body = buildShutdownResponse("r-3", false, "still busy");
    expect(JSON.parse(body)).toEqual({
      type: "shutdown_response",
      request_id: "r-3",
      approve: false,
      feedback: "still busy",
    });
  });
});

describe("shutdown handshake — parsers (request)", () => {
  it("parses valid request", () => {
    expect(parseShutdownRequest('{"type":"shutdown_request","request_id":"r-1"}')).toEqual({
      type: "shutdown_request",
      request_id: "r-1",
    });
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseShutdownRequest("not json")).toBeUndefined();
    expect(parseShutdownRequest("")).toBeUndefined();
  });

  it("returns undefined for wrong type", () => {
    expect(parseShutdownRequest('{"type":"other","request_id":"r-1"}')).toBeUndefined();
  });

  it("returns undefined when request_id is missing or empty", () => {
    expect(parseShutdownRequest('{"type":"shutdown_request"}')).toBeUndefined();
    expect(parseShutdownRequest('{"type":"shutdown_request","request_id":""}')).toBeUndefined();
    expect(parseShutdownRequest('{"type":"shutdown_request","request_id":42}')).toBeUndefined();
  });

  it("returns undefined for plain text body", () => {
    expect(parseShutdownRequest("please shut down")).toBeUndefined();
  });

  it("round-trip via builder + parser", () => {
    const body = buildShutdownRequest("xyz");
    expect(parseShutdownRequest(body)).toEqual({ type: "shutdown_request", request_id: "xyz" });
  });
});

describe("shutdown handshake — parsers (response)", () => {
  it("parses valid response with approve true", () => {
    expect(
      parseShutdownResponse('{"type":"shutdown_response","request_id":"r-1","approve":true}'),
    ).toEqual({ type: "shutdown_response", request_id: "r-1", approve: true });
  });

  it("parses response with feedback", () => {
    expect(
      parseShutdownResponse(
        '{"type":"shutdown_response","request_id":"r-1","approve":false,"feedback":"busy"}',
      ),
    ).toEqual({
      type: "shutdown_response",
      request_id: "r-1",
      approve: false,
      feedback: "busy",
    });
  });

  it("returns undefined for missing approve", () => {
    expect(parseShutdownResponse('{"type":"shutdown_response","request_id":"r-1"}')).toBeUndefined();
  });

  it("returns undefined when approve is not boolean", () => {
    expect(
      parseShutdownResponse('{"type":"shutdown_response","request_id":"r-1","approve":"yes"}'),
    ).toBeUndefined();
  });

  it("returns undefined when feedback is non-string", () => {
    expect(
      parseShutdownResponse(
        '{"type":"shutdown_response","request_id":"r-1","approve":true,"feedback":123}',
      ),
    ).toBeUndefined();
  });

  it("round-trip via builder + parser", () => {
    const body = buildShutdownResponse("z", true, "ok");
    expect(parseShutdownResponse(body)).toEqual({
      type: "shutdown_response",
      request_id: "z",
      approve: true,
      feedback: "ok",
    });
  });
});

describe("detectShutdownProtocol", () => {
  it("returns 'request' for valid request", () => {
    expect(detectShutdownProtocol(buildShutdownRequest("r"))).toBe("request");
  });

  it("returns 'response' for valid response", () => {
    expect(detectShutdownProtocol(buildShutdownResponse("r", true))).toBe("response");
  });

  it("returns undefined for plain text", () => {
    expect(detectShutdownProtocol("hi")).toBeUndefined();
  });

  it("returns undefined for unrelated JSON", () => {
    expect(detectShutdownProtocol('{"foo":"bar"}')).toBeUndefined();
  });
});
