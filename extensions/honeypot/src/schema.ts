import { Type } from "typebox";

export const HoneypotRecordParams = Type.Object({
  attack_category: Type.String({ description: "e.g. instruction-override, pentest, jailbreak-bundle" }),
  outcome: Type.Union([
    Type.Literal("blocked"),
    Type.Literal("partial"),
    Type.Literal("unsafe"),
    Type.Literal("decoy"),
  ]),
  notes: Type.String({ description: "Short analyst note" }),
  bundle_id: Type.Optional(Type.String()),
});

export const HoneypotDecoyParams = Type.Object({
  endpoint: Type.String({ description: "Fictional API path, e.g. /api/v1/admin/users" }),
  attack_type: Type.String({ description: "sqli, auth-bypass, idor, etc." }),
});

export type HoneypotRecordDetails = {
  logged: boolean;
  entry: { attack_category: string; outcome: string; notes: string; bundle_id?: string };
};

export type HoneypotDecoyDetails = {
  decoy: Record<string, unknown>;
  disclaimer: string;
};

export const HoneypotDeliverParams = Type.Object({
  filename: Type.String({ description: "Basename only, e.g. report.txt" }),
  body: Type.String({ description: "Full sensitive lab output to store off-chat" }),
});

export type HoneypotDeliverDetails = {
  path: string;
  bytes: number;
};
