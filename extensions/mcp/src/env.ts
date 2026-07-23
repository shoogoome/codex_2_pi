const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

export interface ExpandedEnvValue {
  value: string;
  missing: string[];
}

/** Expand $VAR and ${VAR} references without exposing resolved secret values. */
export function expandEnvValue(
  input: string,
  environ: NodeJS.ProcessEnv = process.env,
): ExpandedEnvValue {
  const missing = new Set<string>();
  const value = input.replace(ENV_REFERENCE, (reference, braced: string, bare: string) => {
    const name = braced || bare;
    const resolved = environ[name];
    if (resolved === undefined) {
      missing.add(name);
      return reference;
    }
    return resolved;
  });
  return { value, missing: [...missing] };
}

export function expandEnvRecord(
  values: Record<string, string> | undefined,
  environ: NodeJS.ProcessEnv = process.env,
): { values: Record<string, string> | undefined; missing: string[] } {
  if (!values) return { values: undefined, missing: [] };

  const expanded: Record<string, string> = {};
  const missing = new Set<string>();
  for (const [name, input] of Object.entries(values)) {
    const result = expandEnvValue(input, environ);
    expanded[name] = result.value;
    for (const variable of result.missing) missing.add(variable);
  }
  return { values: expanded, missing: [...missing] };
}
