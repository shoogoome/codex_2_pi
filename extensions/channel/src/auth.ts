import { timingSafeEqual } from "node:crypto";

export function isAuthorized(
  authorization: string | string[] | undefined,
  expectedToken: string,
): boolean {
  if (typeof authorization !== "string") return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(authorization);
  if (!match) return false;

  const actual = Buffer.from(match[1]!, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
