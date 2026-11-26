import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2DelegatedFrom } from "./orchestrationV2.ts";
import { OrchestratorMcpThreadStatus } from "./orchestratorMcp.ts";

/**
 * Lists a linked environment's threads for a client of this environment, so it can show every
 * machine's agents in one place. It is read over the link's `/mcp`, which every linked
 * environment serves, so a machine on an older or newer version still answers.
 */
export const PeerLinkThreadsInput = Schema.Struct({
  /** The linked environment whose threads to list. */
  environmentId: EnvironmentId,
});
export type PeerLinkThreadsInput = typeof PeerLinkThreadsInput.Type;

/** One thread on a linked environment. What an older machine does not report is null. */
export const PeerLinkThreadSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  status: OrchestratorMcpThreadStatus,
  /** The provider instance the thread runs on, which is the plan it bills to. */
  providerInstanceId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  /** The thread on another environment whose agent started this one. */
  delegatedFrom: Schema.NullOr(OrchestrationV2DelegatedFrom),
  pinned: Schema.Boolean,
  settled: Schema.Boolean,
  /** The thread waits on another thread it is watching, not on a person. */
  blockedOnThreadWait: Schema.Boolean,
  /** Sub-agents, commands and monitors the thread still waits on. */
  backgroundTaskCount: NonNegativeInt,
  /**
   * Approvals and questions waiting for an answer. Read only for a thread whose run waits, so
   * null for the rest, and for a machine too old to say.
   */
  pendingRequestCount: Schema.NullOr(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PeerLinkThreadSummary = typeof PeerLinkThreadSummary.Type;

export const PeerLinkThreadsResult = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Every thread whose run is under way, then the most recently updated of the rest. */
  threads: Schema.Array(PeerLinkThreadSummary),
  /** How many threads the linked environment holds in all, `threads` included. */
  total: NonNegativeInt,
  readAt: IsoDateTime,
});
export type PeerLinkThreadsResult = typeof PeerLinkThreadsResult.Type;
