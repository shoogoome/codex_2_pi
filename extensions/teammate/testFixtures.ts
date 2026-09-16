// Shared test fixtures for the teammate extension.
//
// These exist so a change to a required `TeammateHandle` field does not
// require editing every hand-rolled fixture in the suite (adding
// `approvalRequests` did exactly that once).

import type { TeammateHandle } from "./handle.js";
import { createApprovalRequestRegistry } from "./handle.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";
import { createTeamTaskStore } from "./teamTasks/teamTaskStore.js";

/** A fresh, fully-populated TeammateHandle for tests. */
export function createTestTeammateHandle(
  overrides: Partial<TeammateHandle> = {},
): TeammateHandle {
  return {
    teamStore: createTeamStore(),
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
    approvalRequests: createApprovalRequestRegistry(),
    ...overrides,
  };
}
