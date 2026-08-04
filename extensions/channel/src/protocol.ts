import { randomUUID } from "node:crypto";
import type {
  ChannelDelivery,
  ParsedChannelMessage,
} from "./types.js";

const DELIVERIES = new Set<ChannelDelivery>([
  "steer",
  "followUp",
  "nextTurn",
]);
const SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export class ChannelProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChannelProtocolError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ChannelProtocolError("invalid_id", "id must be a string");
  }
  const id = value.trim();
  if (id.length === 0 || id.length > 128 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new ChannelProtocolError(
      "invalid_id",
      "id must contain 1-128 printable characters",
    );
  }
  return id;
}

export function validateIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const key = value.trim();
  if (key.length === 0 || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new ChannelProtocolError(
      "invalid_idempotency_key",
      "Idempotency-Key must contain 1-128 printable characters",
    );
  }
  return key;
}

export function parseChannelMessage(
  value: unknown,
  options: {
    now?: () => Date;
    idFactory?: () => string;
  } = {},
): ParsedChannelMessage {
  if (!isRecord(value)) {
    throw new ChannelProtocolError("invalid_body", "request body must be a JSON object");
  }

  if (typeof value.source !== "string" || !SOURCE_PATTERN.test(value.source)) {
    throw new ChannelProtocolError(
      "invalid_source",
      "source must match [A-Za-z0-9][A-Za-z0-9._:/-]{0,127}",
    );
  }
  if (typeof value.content !== "string" || value.content.trim() === "") {
    throw new ChannelProtocolError(
      "invalid_content",
      "content must be a non-empty string",
    );
  }

  const requestedDelivery = value.delivery ?? "steer";
  if (
    typeof requestedDelivery !== "string" ||
    !DELIVERIES.has(requestedDelivery as ChannelDelivery)
  ) {
    throw new ChannelProtocolError(
      "invalid_delivery",
      "delivery must be steer, followUp, or nextTurn",
    );
  }
  if (value.wake !== undefined && typeof value.wake !== "boolean") {
    throw new ChannelProtocolError("invalid_wake", "wake must be a boolean");
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    throw new ChannelProtocolError(
      "invalid_metadata",
      "metadata must be a JSON object",
    );
  }

  const suppliedId = validateId(value.id);
  const id = suppliedId ?? (options.idFactory ?? randomUUID)();
  const now = (options.now ?? (() => new Date()))();
  const delivery = requestedDelivery as ChannelDelivery;

  return {
    explicitId: suppliedId !== undefined,
    message: {
      id,
      source: value.source,
      content: value.content,
      delivery,
      // nextTurn never wakes in Pi; normalizing it prevents misleading details.
      wake: delivery === "nextTurn" ? false : (value.wake ?? true),
      ...(value.metadata === undefined
        ? {}
        : { metadata: value.metadata as Record<string, unknown> }),
      receivedAt: now.toISOString(),
    },
  };
}
