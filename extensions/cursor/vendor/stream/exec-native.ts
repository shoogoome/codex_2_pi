/** Native non-local handlers retained on the open Cursor stream. */
import { create } from "@bufbuild/protobuf";
import {
  DiagnosticsResultSchema,
  DiagnosticsSuccessSchema,
  FetchErrorSchema,
  FetchResultSchema,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesSuccessSchema,
} from "../proto/agent_pb.js";

export type NativeExecFrame = { resultCase: string; value: unknown };
export type NativeExecDispatch =
  { kind: "sync"; frame: NativeExecFrame } | { kind: "async"; run: () => Promise<NativeExecFrame> };

/** Dispatches retained native handlers; local file and shell operations have no executor here. */
export function dispatchNativeExec(
  execCase: string,
  args: Record<string, unknown>,
): NativeExecDispatch | undefined {
  switch (execCase) {
    case "diagnosticsArgs":
      return { kind: "sync", frame: execDiagnostics(args) };
    case "listMcpResourcesExecArgs":
      return {
        kind: "sync",
        frame: {
          resultCase: "listMcpResourcesExecResult",
          value: create(ListMcpResourcesExecResultSchema, {
            result: {
              case: "success",
              value: create(ListMcpResourcesSuccessSchema, { resources: [] }),
            },
          }),
        },
      };
    case "fetchArgs":
      // Networking must pass through Pi's tool/approval layer, never this transport.
      return {
        kind: "sync",
        frame: fetchError("", "Native fetch is disabled. Use the provided Pi tools instead."),
      };
    default:
      return undefined;
  }
}

/** Returns an empty diagnostic result because this provider does not run workspace diagnostics. */
function execDiagnostics(args: Record<string, unknown>): NativeExecFrame {
  const rawPath = typeof args.path === "string" ? args.path : "";
  return {
    resultCase: "diagnosticsResult",
    value: create(DiagnosticsResultSchema, {
      result: {
        case: "success",
        value: create(DiagnosticsSuccessSchema, {
          path: rawPath,
          diagnostics: [],
          totalDiagnostics: 0,
        }),
      },
    }),
  };
}

/** Wraps a fetch failure in the typed result expected by the waiting Cursor request. */
function fetchError(url: string, error: string): NativeExecFrame {
  return {
    resultCase: "fetchResult",
    value: create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url, error }) },
    }),
  };
}
