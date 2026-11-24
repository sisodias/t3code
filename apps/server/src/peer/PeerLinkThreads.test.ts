import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLink,
  PeerLinkThreadReadError,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PeerLinkThreads from "./PeerLinkThreads.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const box = EnvironmentId.make("environment-box");
const link: PeerLink = {
  environmentId: box,
  label: "Build box",
  urls: ["http://box.test"],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe("2026-11-20T09:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2027-11-20T09:00:00.000Z"),
  lastReachedAt: null,
  lastError: null,
};

const thread = (id: string, fields: Record<string, unknown> = {}) => ({
  threadId: id,
  title: `Thread ${id}`,
  projectId: "project-site",
  status: "idle",
  providerInstanceId: "claude-team",
  model: "claude-opus-5-5",
  parentThreadId: null,
  relationshipToParent: null,
  pinned: false,
  settled: false,
  createdAt: "2026-11-24T08:00:00.000Z",
  updatedAt: "2026-11-24T09:00:00.000Z",
  ...fields,
});

interface Call {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly limits: PeerMcpClient.PeerCallLimits;
}

/** A linked environment that answers each tool from `answer`, decoded as the real client does. */
const fixture = (options: {
  readonly enabled?: boolean;
  readonly linked?: boolean;
  readonly answer: (call: Call) => Effect.Effect<unknown, OrchestratorMcpFailure>;
}) => {
  const calls: Array<Call> = [];
  const layer = PeerLinkThreads.layer.pipe(
    Layer.provide(
      Layer.mock(PeerLinks.PeerLinks)({
        enabled: Effect.succeed(options.enabled ?? true),
        get: (environmentId) =>
          Effect.succeed(
            options.linked === false || environmentId !== box ? Option.none() : Option.some(link),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(PeerMcpClient.PeerMcpClient)({
        call: (input) => {
          calls.push({ tool: input.tool, arguments: input.arguments, limits: input.limits });
          return options.answer(input).pipe(
            Effect.flatMap((raw) =>
              // oxlint-disable-next-line t3code/no-inline-schema-compile -- decodes with the schema each call passes, as the real client does
              Schema.decodeUnknownEffect(input.success)(raw).pipe(
                Effect.mapError(
                  () =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: "did not match",
                    }),
                ),
              ),
            ),
          );
        },
      }),
    ),
  );
  return { calls, layer };
};

const list = PeerLinkThreads.PeerLinkThreads.use((service) => service.list({ environmentId: box }));

it.effect(
  "lists what runs now and what changed last, each once, with what waits on a person",
  () => {
    const { calls, layer } = fixture({
      answer: (call) => {
        if (call.tool === "t3_thread_read") {
          return Effect.succeed({
            thread: { pendingRequestCount: call.arguments.threadId === "asks" ? 1 : 0 },
            items: [],
          });
        }
        if (call.arguments.statuses !== undefined) {
          return Effect.succeed({
            threads: [
              thread("asks", { status: "waiting" }),
              thread("watches", { status: "waiting", blockedOnThreadWait: true }),
              thread("helper", {
                status: "running",
                parentThreadId: "watches",
                relationshipToParent: "subagent",
              }),
            ],
            nextCursor: null,
            total: 3,
          });
        }
        return Effect.succeed({
          threads: [thread("asks", { status: "waiting" }), thread("quiet")],
          nextCursor: null,
          total: 12,
        });
      },
    });
    return Effect.gen(function* () {
      const result = yield* list;
      expect(result.label).toBe("Build box");
      expect(result.total).toBe(12);
      expect(result.threads.map((item) => item.threadId)).toEqual([
        "asks",
        "watches",
        "helper",
        "quiet",
      ]);
      const byId = new Map(result.threads.map((item) => [String(item.threadId), item]));
      expect(byId.get("asks")?.pendingRequestCount).toBe(1);
      // A thread that waits on another thread is not read again: it waits on no person.
      expect(byId.get("watches")?.pendingRequestCount).toBeNull();
      expect(byId.get("helper")).toMatchObject({
        parentThreadId: "watches",
        relationshipToParent: "subagent",
        providerInstanceId: "claude-team",
      });
      expect(byId.get("helper")?.pendingRequestCount).toBe(0);
      expect(
        calls
          .filter((call) => call.tool === "t3_thread_read")
          .map((call) => call.arguments.threadId),
      ).toEqual(["asks", "helper"]);
      // Every call lists across projects with sub-agents, at the narrowest modes.
      for (const call of calls.filter((item) => item.tool === "t3_thread_list")) {
        expect(call.arguments).toMatchObject({ allProjects: true, includeSubagents: true });
      }
      expect(new Set(calls.map((call) => call.limits.runtimeMode))).toEqual(
        new Set(["approval-required"]),
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("lists a machine on another version with what it does report", () => {
  const { layer } = fixture({
    answer: (call) =>
      call.tool === "t3_thread_read"
        ? Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message: "no" }))
        : Effect.succeed({
            threads: [
              { threadId: "bare", title: "Bare", status: "hibernating", extra: { x: 1 } },
              { threadId: "untitled" },
              thread("waits", { status: "waiting", delegatedFrom: { nonsense: true } }),
            ],
          }),
  });
  return Effect.gen(function* () {
    const result = yield* list;
    expect(result.threads.map((item) => item.threadId)).toEqual(["bare", "waits"]);
    expect(result.threads[0]).toMatchObject({
      status: "idle",
      projectId: null,
      providerInstanceId: null,
      parentThreadId: null,
      backgroundTaskCount: 0,
      pendingRequestCount: null,
    });
    expect(result.threads[0]?.updatedAt).toBe(result.readAt);
    // A waiting thread that cannot be read again is still listed.
    expect(result.threads[1]).toMatchObject({ delegatedFrom: null, pendingRequestCount: null });
    expect(result.total).toBe(2);
  }).pipe(Effect.provide(layer));
});

it.effect("says why a machine's threads cannot be listed", () =>
  Effect.gen(function* () {
    const off = fixture({ enabled: false, answer: () => Effect.succeed({ threads: [] }) });
    expect(yield* list.pipe(Effect.flip, Effect.provide(off.layer))).toMatchObject({
      reason: "disabled",
    });
    expect(off.calls).toEqual([]);

    const gone = fixture({ linked: false, answer: () => Effect.succeed({ threads: [] }) });
    expect(yield* list.pipe(Effect.flip, Effect.provide(gone.layer))).toMatchObject({
      reason: "unknown_link",
    });

    const refused = fixture({
      answer: () =>
        Effect.fail(
          new OrchestratorMcpFailure({ code: "capability_denied", message: "Reading is off." }),
        ),
    });
    const refusal = yield* list.pipe(Effect.flip, Effect.provide(refused.layer));
    expect(refusal).toBeInstanceOf(PeerLinkThreadReadError);
    expect(refusal).toMatchObject({
      reason: "rejected",
      label: "Build box",
      message: "Reading is off.",
    });

    const silent = fixture({
      answer: () =>
        Effect.fail(
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The linked environment stopped answering.",
          }),
        ),
    });
    expect(yield* list.pipe(Effect.flip, Effect.provide(silent.layer))).toMatchObject({
      reason: "unreachable",
      label: "Build box",
    });
  }),
);
