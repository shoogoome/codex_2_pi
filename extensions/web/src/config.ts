/**
 * Flag/env resolution for the web extension.
 *
 * Supported flags:
 *   --web            enable the web server (auto-start on session start)
 *   --web-host       bind host (default 0.0.0.0)
 *   --web-port       port (default 8600; 0 = random free port)
 *   --web-token      optional bearer token for API + UI (empty = no auth)
 *
 * Env fallbacks (PI_WEB_HOST / PI_WEB_PORT / PI_WEB_TOKEN / PI_WEB=1/0) mirror
 * the flags so the server can be enabled headlessly without extra CLI args.
 */

export interface WebServerConfig {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
}

export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 8600;

function envEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.PI_WEB;
  if (raw === undefined) return false;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function envString(name: string, fallback: string, env: NodeJS.ProcessEnv): string {
  const raw = env[name]?.trim();
  return raw ? raw : fallback;
}

function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Resolve effective config from flags then env.
 * @param getFlag - flag reader (pi.getFlag), optional for unit tests.
 */
export function resolveWebConfig(
  getFlag: (name: string) => unknown = () => undefined,
  env: NodeJS.ProcessEnv = process.env,
): WebServerConfig {
  const flagValue = getFlag("web") as boolean | string | undefined;
  const flagEnabled = flagValue === true || flagValue === "true";
  const explicitlyDisabled = flagValue === false || flagValue === "false";
  const envFlag = !explicitlyDisabled && envEnabled(env);
  const enabled = explicitlyDisabled ? false : flagEnabled || envFlag;

  const host = (getFlag("web-host") as string | undefined) ?? envString("PI_WEB_HOST", DEFAULT_HOST, env);
  const portValue = (getFlag("web-port") as string | number | undefined) ?? envInt("PI_WEB_PORT", DEFAULT_PORT, env);
  const port = typeof portValue === "number" ? portValue : Number.parseInt(String(portValue), 10);
  const token = (getFlag("web-token") as string | undefined) ?? envString("PI_WEB_TOKEN", "", env);

  return {
    enabled,
    host,
    port: Number.isNaN(port) ? DEFAULT_PORT : port,
    token: token.trim(),
  };
}
