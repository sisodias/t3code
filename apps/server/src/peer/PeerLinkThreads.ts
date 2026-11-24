import {
  type EnvironmentId,
  OrchestrationV2DelegatedFrom,
  type OrchestratorMcpFailure,
  OrchestratorMcpThreadStatus,
  type OrchestrationV2ThreadLine,
  type PeerLinkThreadsInput,
  type PeerLinkThreadsResult,
  type PeerLinkThreadStop,
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

import { oneLine, THREAD_LINE_CHARS, threadLineOf } from "../orchestration-v2/threadLine.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** Every thread whose run is under way, plus this many of the most recently updated. */
const RECENT_THREAD_LIMIT = 50;
const ACTIVE_THREAD_LIMIT = 100;
/**
 * Threads read once more per listing, for what they last said and whether a person is asked
 * something: every live one, then the latest of the rest not read since they last changed.
 */
const DETAIL_READ_LIMIT = 40;
/** provider-core titles a run's terminal failure item this way when a usage limit stopped it. */
const USAGE_LIMIT_ITEM_TITLE = "Usage limit reached";
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
  items: Schema.optional(Schema.Array(Schema.Unknown)),
});
const TimelineItem = Schema.Struct({
  type: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeListedThread = Schema.decodeUnknownOption(ListedThread);
const decodeDelegatedFrom = Schema.decodeUnknownOption(OrchestrationV2DelegatedFrom);
const decodeTimelineItem = Schema.decodeUnknownOption(TimelineItem);
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

/** A run held on an approval still lists as running, so these are read on every listing. */
const isLive = (thread: PeerLinkThreadSummary) =>
  thread.status === "running" || thread.status === "waiting";

/** What one more read of a thread adds to its listing. */
interface ThreadDetailRead {
  readonly pendingRequestCount: number | null;
  readonly latestMessage: OrchestrationV2ThreadLine | null;
  readonly stop: PeerLinkThreadStop | null;
}

interface CachedRead {
  readonly status: string;
  readonly updatedAt: string;
  readonly read: ThreadDetailRead;
}

/**
 * The newest message and, for a failed run, its failure, from a page of the thread's timeline.
 * A page lists its newest item last.
 */
function readTimeline(pendingRequestCount: number | undefined, rawItems: ReadonlyArray<unknown>) {
  let latestMessage: OrchestrationV2ThreadLine | null = null;
  let stop: PeerLinkThreadStop | null = null;
  for (const raw of rawItems.toReversed()) {
    const item = Option.getOrNull(decodeTimelineItem(raw));
    if (item === null) continue;
    latestMessage ??= threadLineOf(item.type, item.text);
    if (stop === null && item.type === "error") {
      const title = item.title ?? "";
      stop = {
        usageLimit: title === USAGE_LIMIT_ITEM_TITLE,
        message: oneLine(item.text ?? "") || oneLine(title),
      };
    }
  }
  return {
    pendingRequestCount:
      pendingRequestCount === undefined ? null : Math.max(0, Math.trunc(pendingRequestCount)),
    latestMessage,
    stop,
  } satisfies ThreadDetailRead;
}

const withRead = (
  thread: PeerLinkThreadSummary,
  read: ThreadDetailRead,
): PeerLinkThreadSummary => ({
  ...thread,
  pendingRequestCount: read.pendingRequestCount,
  ...(read.latestMessage === null ? {} : { latestMessage: read.latestMessage }),
  ...(read.stop === null ? {} : { stop: read.stop }),
});

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
  // A quiet thread's last message and failure stay as they were until it changes again.
  const readsByEnvironment = new Map<EnvironmentId, ReadonlyMap<string, CachedRead>>();

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

      // The list says neither what a thread last said nor whether a person is asked something.
      const previous = readsByEnvironment.get(input.environmentId) ?? new Map();
      const reads = new Map<string, CachedRead>();
      const unread: Array<PeerLinkThreadSummary> = [];
      for (const thread of byId.values()) {
        const cached = previous.get(thread.threadId);
        if (
          !isLive(thread) &&
          cached?.status === thread.status &&
          cached.updatedAt === thread.updatedAt
        ) {
          reads.set(thread.threadId, cached);
        } else {
          unread.push(thread);
        }
      }
      const toRead = [
        ...unread.filter(isLive),
        ...unread.filter((thread) => !isLive(thread)),
      ].slice(0, DETAIL_READ_LIMIT);
      yield* Effect.forEach(
        toRead,
        (thread) =>
          call(
            "t3_thread_read",
            {
              threadId: thread.threadId,
              // A failed run's failure is an activity item, not a message.
              ...(thread.status === "failed" ? { view: "activity", limit: 4 } : { limit: 1 }),
              runLimit: 1,
              maxCharsPerItem: THREAD_LINE_CHARS,
            },
            ThreadDetail,
          ).pipe(
            Effect.map(({ thread: detail, items }) => {
              reads.set(thread.threadId, {
                status: thread.status,
                updatedAt: thread.updatedAt,
                read: readTimeline(detail.pendingRequestCount, items ?? []),
              });
            }),
            // One thread that cannot be read still leaves the rest listed.
            Effect.ignore,
          ),
        { concurrency: 4, discard: true },
      );
      readsByEnvironment.set(input.environmentId, reads);
      for (const [threadId, { read }] of reads) {
        const thread = byId.get(threadId);
        if (thread !== undefined) byId.set(threadId, withRead(thread, read));
      }

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
