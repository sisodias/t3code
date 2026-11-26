import {
  OrchestrationV2DelegatedFrom,
  type OrchestratorMcpFailure,
  OrchestratorMcpThreadStatus,
  type PeerLinkThreadsInput,
  type PeerLinkThreadsResult,
  type PeerLinkThreadSummary,
  PeerLinkThreadReadError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** Every thread whose run is under way, plus this many of the most recently updated. */
const RECENT_THREAD_LIMIT = 50;
const ACTIVE_THREAD_LIMIT = 100;
/** Live threads read once more, to learn whether a person is asked something. */
const LIVE_DETAIL_LIMIT = 20;
const ACTIVE_STATUSES = ["preparing", "queued", "starting", "running", "waiting"] as const;

/** Listing only reads, so it carries the narrowest modes; the link's own access caps the rest. */
const READ_LIMITS: PeerMcpClient.PeerCallLimits = {
  runtimeMode: "approval-required",
  interactionMode: "default",
};

/**
 * Only the fields the fleet shows, each optional: a linked environment on another version adds,
 * drops or renames fields, and its threads should still be listed with what it does report.
 */
const ListedThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  providerInstanceId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  relationshipToParent: Schema.optional(Schema.NullOr(Schema.String)),
  delegatedFrom: Schema.optional(Schema.Unknown),
  pinned: Schema.optional(Schema.Boolean),
  settled: Schema.optional(Schema.Boolean),
  blockedOnThreadWait: Schema.optional(Schema.Boolean),
  pendingBackgroundTasks: Schema.optional(Schema.Array(Schema.Unknown)),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
});
const ListPage = Schema.Struct({
  threads: Schema.Array(Schema.Unknown),
  total: Schema.optional(Schema.Number),
});
const ThreadDetail = Schema.Struct({
  thread: Schema.Struct({ pendingRequestCount: Schema.optional(Schema.Number) }),
});

const decodeListedThread = Schema.decodeUnknownOption(ListedThread);
const decodeDelegatedFrom = Schema.decodeUnknownOption(OrchestrationV2DelegatedFrom);
const isThreadStatus = Schema.is(OrchestratorMcpThreadStatus);

/** One listed thread in this version's terms, or nothing when it lacks an id or a title. */
function toThreadSummary(raw: unknown, readAt: string): PeerLinkThreadSummary | null {
  const decoded = decodeListedThread(raw);
  if (Option.isNone(decoded)) return null;
  const thread = decoded.value;
  const relationship = thread.relationshipToParent;
  return {
    threadId: thread.threadId,
    title: thread.title,
    projectId: thread.projectId ?? null,
    status: isThreadStatus(thread.status) ? thread.status : "idle",
    providerInstanceId: thread.providerInstanceId ?? null,
    model: thread.model ?? null,
    parentThreadId: thread.parentThreadId ?? null,
    relationshipToParent:
      relationship === "fork" || relationship === "subagent" ? relationship : null,
    delegatedFrom: Option.getOrNull(decodeDelegatedFrom(thread.delegatedFrom)),
    pinned: thread.pinned ?? false,
    settled: thread.settled ?? false,
    blockedOnThreadWait: thread.blockedOnThreadWait ?? false,
    backgroundTaskCount: thread.pendingBackgroundTasks?.length ?? 0,
    pendingRequestCount: null,
    createdAt: thread.createdAt ?? thread.updatedAt ?? readAt,
    updatedAt: thread.updatedAt ?? thread.createdAt ?? readAt,
  };
}

/** A run held on an approval still lists as running, so only one watching a thread is skipped. */
const mayWaitOnPerson = (thread: PeerLinkThreadSummary) =>
  (thread.status === "running" || thread.status === "waiting") && !thread.blockedOnThreadWait;

/**
 * Lists a linked environment's threads for this environment's clients: what runs there now and
 * what changed last, each with the plan it bills to and the thread it hangs under.
 */
export class PeerLinkThreads extends Context.Service<
  PeerLinkThreads,
  {
    readonly list: (
      input: PeerLinkThreadsInput,
    ) => Effect.Effect<PeerLinkThreadsResult, PeerLinkThreadReadError>;
  }
>()("t3/peer/PeerLinkThreads") {}

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;

  const list: PeerLinkThreads["Service"]["list"] = Effect.fn("PeerLinkThreads.list")(
    function* (input) {
      if (!(yield* links.enabled)) {
        return yield* new PeerLinkThreadReadError({
          reason: "disabled",
          label: null,
          message: PeerLinks.LINKED_ENVIRONMENTS_OFF,
        });
      }
      const link = yield* links.get(input.environmentId).pipe(
        Effect.mapError(
          (error) =>
            new PeerLinkThreadReadError({
              reason: "unreachable",
              label: null,
              message: "This environment could not read its links.",
              cause: error,
            }),
        ),
      );
      if (Option.isNone(link)) {
        return yield* new PeerLinkThreadReadError({
          reason: "unknown_link",
          label: null,
          message: "This environment is no longer linked to that one.",
        });
      }
      const { label } = link.value;
      const refused = (failure: OrchestratorMcpFailure) =>
        new PeerLinkThreadReadError({
          reason: failure.code === "capability_denied" ? "rejected" : "unreachable",
          label,
          message: failure.message,
          cause: failure,
        });
      const call = <S extends Schema.Decoder<unknown>>(
        tool: string,
        args: Record<string, unknown>,
        success: S,
      ) =>
        peers
          .call({
            environmentId: input.environmentId,
            tool,
            arguments: args,
            limits: READ_LIMITS,
            success,
          })
          .pipe(Effect.mapError(refused));

      const listed = { allProjects: true, includeSubagents: true } as const;
      const [active, recent] = yield* Effect.all(
        [
          call(
            "t3_thread_list",
            { ...listed, statuses: ACTIVE_STATUSES, limit: ACTIVE_THREAD_LIMIT },
            ListPage,
          ),
          call("t3_thread_list", { ...listed, limit: RECENT_THREAD_LIMIT }, ListPage),
        ],
        { concurrency: 2 },
      );
      const readAt = DateTime.formatIso(yield* DateTime.now);
      const byId = new Map<string, PeerLinkThreadSummary>();
      for (const raw of [...active.threads, ...recent.threads]) {
        const thread = toThreadSummary(raw, readAt);
        if (thread !== null && !byId.has(thread.threadId)) byId.set(thread.threadId, thread);
      }

      // The list does not say whether a run waits on a person, so those few are read in full.
      const live = [...byId.values()].filter(mayWaitOnPerson).slice(0, LIVE_DETAIL_LIMIT);
      yield* Effect.forEach(
        live,
        (thread) =>
          call(
            "t3_thread_read",
            { threadId: thread.threadId, limit: 1, runLimit: 1, maxCharsPerItem: 1 },
            ThreadDetail,
          ).pipe(
            Effect.map(({ thread: detail }) => {
              if (detail.pendingRequestCount === undefined) return;
              byId.set(thread.threadId, {
                ...thread,
                pendingRequestCount: Math.max(0, Math.trunc(detail.pendingRequestCount)),
              });
            }),
            // One thread that cannot be read still leaves the rest listed.
            Effect.ignore,
          ),
        { concurrency: 4, discard: true },
      );

      return {
        environmentId: input.environmentId,
        label,
        threads: [...byId.values()],
        total: Math.max(byId.size, Math.trunc(recent.total ?? 0)),
        readAt,
      };
    },
  );

  return PeerLinkThreads.of({ list });
});

export const layer = Layer.effect(PeerLinkThreads, make);
