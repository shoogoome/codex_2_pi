// Role field validation. Mirrors claude/components/agents/validateAgent.ts.

import type { AgentRole } from "./types.js";

const AGENT_TYPE_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/;

export interface AgentTypeValidation {
  isValid: boolean;
  error?: string;
}

export function validateAgentType(name: string): AgentTypeValidation {
  if (!name || name.trim() === "") {
    return { isValid: false, error: "name is required" };
  }
  const trimmed = name.trim();
  if (trimmed.length < 3) {
    return { isValid: false, error: "name must be at least 3 characters" };
  }
  if (trimmed.length > 50) {
    return { isValid: false, error: "name must be at most 50 characters" };
  }
  if (!AGENT_TYPE_RE.test(trimmed)) {
    return {
      isValid: false,
      error:
        "name must start and end with a letter or digit and contain only letters, digits and hyphens",
    };
  }
  return { isValid: true };
}

export interface RoleValidation {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a role's fields.
 *   - name: required + type rules + cross-source duplicate conflict
 *   - description: required (warn if <10 or >5000)
 *   - tools: must be string[]; unknown tools warned when availableTools given
 *   - systemPrompt: required (err <20, warn >10000)
 */
export function validateRole(
  role: AgentRole,
  availableTools?: readonly string[],
  existing?: readonly AgentRole[],
): RoleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // name
  const typeCheck = validateAgentType(role.agentType);
  if (!typeCheck.isValid) {
    errors.push(typeCheck.error ?? "invalid name");
  } else if (existing) {
    for (const other of existing) {
      if (other === role) continue;
      if (other.agentType === role.agentType && other.source !== role.source) {
        warnings.push(
          `name "${role.agentType}" also defined by source "${other.source}" (this ${role.source} definition wins)`,
        );
        break;
      }
    }
  }

  // description / whenToUse
  if (!role.whenToUse || role.whenToUse.trim() === "") {
    errors.push("description is required");
  } else {
    if (role.whenToUse.length < 10) {
      warnings.push("description is very short (<10 chars)");
    }
    if (role.whenToUse.length > 5000) {
      warnings.push("description is very long (>5000 chars)");
    }
  }

  // tools
  if (role.tools !== undefined) {
    if (!Array.isArray(role.tools)) {
      errors.push("tools must be an array");
    } else if (availableTools && !role.tools.includes("*")) {
      const known = new Set(availableTools);
      for (const t of role.tools) {
        if (!known.has(t)) warnings.push(`unknown tool "${t}"`);
      }
    }
  }

  // systemPrompt
  if (!role.systemPrompt || role.systemPrompt.trim() === "") {
    errors.push("systemPrompt is required");
  } else {
    if (role.systemPrompt.length < 20) {
      errors.push("systemPrompt is too short (<20 chars)");
    }
    if (role.systemPrompt.length > 10000) {
      warnings.push("systemPrompt is very long (>10000 chars)");
    }
  }

  return { isValid: errors.length === 0, errors, warnings };
}
