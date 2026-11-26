import { EnvironmentId, type PeerLinkThreadSummary, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFleetView,
  countFleetAttention,
  type FleetMachine,
  type FleetThread,
  fleetLine,
  fleetThreadFromLinked,
  fleetThreadFromShell,
  plainLine,
} from "./fleet.logic";

const laptop = EnvironmentId.make("environment-laptop");
const box = EnvironmentId.make("environment-box");

const thread = (
  environmentId: EnvironmentId,
  id: string,
  fields: Partial<FleetThread> = {},
): FleetThread => ({
  environmentId,
  threadId: ThreadId.make(id),
  title: id,
  attention: null,
  helperAttention: null,
  activity: "idle",
  plan: "claude-team",
  model: "claude-opus-5-5",
  parentThreadId: null,
  relationship: null,
  delegatedFrom: null,
  pinned: false,
  settled: false,
  backgroundTaskCount: 0,
  updatedAt: "2026-11-24T09:00:00.000Z",
  line: null,
  ...fields,
});

const machine = (
  environmentId: EnvironmentId,
  threads: ReadonlyArray<FleetThread>,
  fields: Partial<FleetMachine> = {},
): FleetMachine => ({
  environmentId,
  label: environmentId === laptop ? "Laptop" : "Build box",
  reach: { kind: "connected" },
  state: "ready",
  error: null,
  threads,
  ...fields,
});

describe("buildFleetView", () => {
  it("hangs lanes and helpers under their owner, including lanes another machine runs", () => {
    const view = buildFleetView([
      machine(laptop, [
        thread(laptop, "owner", { pinned: true }),
        thread(laptop, "fork", {
          parentThreadId: ThreadId.make("owner"),
          relationship: "fork",
          activity: "working",
        }),
        thread(laptop, "helper", {
          parentThreadId: ThreadId.make("fork"),
          relationship: "subagent",
          activity: "working",
        }),
      ]),
      machine(box, [
        thread(box, "remote-lane", {
          delegatedFrom: { environmentId: laptop, threadId: ThreadId.make("owner") },
          activity: "working",
        }),
      ]),
    ]);

    const [laptopView, boxView] = view.machines;
    expect(laptopView?.owners.map((node) => node.thread.title)).toEqual(["owner"]);
    const owner = laptopView?.owners[0];
    expect(owner).toMatchObject({ kind: "owner", lanes: 2, helpers: 0, working: 3, live: true });
    expect(owner?.children.map((node) => [node.thread.title, node.kind])).toEqual([
      ["fork", "lane"],
      ["remote-lane", "lane"],
    ]);
    expect(owner?.children[0]?.children.map((node) => [node.thread.title, node.kind])).toEqual([
      ["helper", "helper"],
    ]);
    // The box runs the lane, so it counts there, but it is drawn under its owner only.
    expect(boxView?.owners).toEqual([]);
    expect(boxView?.working).toBe(1);
    expect(view.working).toBe(3);
  });

  it("puts what waits on the owner first, with the owner chat it sits under", () => {
    const view = buildFleetView([
      machine(laptop, [
        thread(laptop, "owner"),
        thread(laptop, "stopped", { attention: "stopped", updatedAt: "2026-11-24T10:00:00.000Z" }),
      ]),
      machine(box, [
        thread(box, "asks", {
          attention: "request",
          delegatedFrom: { environmentId: laptop, threadId: ThreadId.make("owner") },
        }),
      ]),
    ]);
    expect(
      view.needsYou.map((row) => [row.thread.title, row.machineLabel, row.owner?.title]),
    ).toEqual([
      ["asks", "Build box", "owner"],
      ["stopped", "Laptop", undefined],
    ]);
    expect(view.machines[0]?.owners.map((node) => node.thread.title)).toEqual(["owner", "stopped"]);
    expect(view.machines[0]?.owners[0]?.attention).toBe(1);
  });

  it("shows every live owner but only the latest quiet ones", () => {
    const quiet = Array.from({ length: 5 }, (_, index) =>
      thread(laptop, `quiet-${index}`, {
        updatedAt: `2026-11-2${index}T09:00:00.000Z`,
      }),
    );
    const view = buildFleetView(
      [
        machine(laptop, [
          ...quiet,
          thread(laptop, "settled", { settled: true, updatedAt: "2026-11-30T09:00:00.000Z" }),
          thread(laptop, "running", { activity: "working", updatedAt: "2026-11-01T09:00:00.000Z" }),
        ]),
      ],
      { quietOwnerLimit: 2 },
    );
    expect(view.machines[0]?.owners.map((node) => node.thread.title)).toEqual([
      "running",
      "quiet-4",
      "quiet-3",
    ]);
    expect(view.machines[0]?.hiddenOwners).toBe(4);
  });

  it("keeps a machine it cannot read, and threads whose parents loop", () => {
    const view = buildFleetView([
      machine(laptop, [
        thread(laptop, "a", { parentThreadId: ThreadId.make("b"), relationship: "fork" }),
        thread(laptop, "b", { parentThreadId: ThreadId.make("a"), relationship: "fork" }),
      ]),
      machine(box, [], {
        state: "unreachable",
        error: "The linked environment stopped answering.",
        reach: { kind: "linked", viaEnvironmentId: laptop },
      }),
    ]);
    const owners = view.machines[0]?.owners ?? [];
    expect(owners).toHaveLength(1);
    expect(owners[0]?.children).toHaveLength(1);
    expect(view.unreachable).toBe(1);
    expect(view.machines[1]).toMatchObject({ state: "unreachable", owners: [] });
  });
});

describe("fleetThreadFromLinked", () => {
  const summary: PeerLinkThreadSummary = {
    threadId: ThreadId.make("remote"),
    title: "Remote",
    projectId: null,
    status: "waiting",
    providerInstanceId: "claude-team",
    model: "claude-opus-5-5",
    parentThreadId: null,
    relationshipToParent: null,
    delegatedFrom: null,
    pinned: false,
    settled: false,
    blockedOnThreadWait: false,
    backgroundTaskCount: 0,
    pendingRequestCount: 1,
    createdAt: "2026-11-24T08:00:00.000Z",
    updatedAt: "2026-11-24T09:00:00.000Z",
  };

  it("reads a waiting request, a failure and a run under way", () => {
    expect(fleetThreadFromLinked(box, summary)).toMatchObject({
      attention: "request",
      activity: "waiting",
      plan: "claude-team",
    });
    expect(
      fleetThreadFromLinked(box, { ...summary, status: "failed", pendingRequestCount: null }),
    ).toMatchObject({ attention: "stopped", activity: "idle" });
    expect(
      fleetThreadFromLinked(box, {
        ...summary,
        status: "failed",
        settled: true,
        pendingRequestCount: null,
      }).attention,
    ).toBeNull();
    expect(
      fleetThreadFromLinked(box, { ...summary, status: "running", pendingRequestCount: null }),
    ).toMatchObject({ attention: null, activity: "working" });
  });

  it("shows a helper's request once, on the helper, or on its parent when the helper is not listed", () => {
    const owner = thread(laptop, "owner", { helperAttention: "approval" });
    const helper = thread(laptop, "helper", {
      parentThreadId: ThreadId.make("owner"),
      relationship: "subagent",
      attention: "approval",
      activity: "working",
    });
    const listed = buildFleetView([machine(laptop, [owner, helper])]);
    expect(listed.needsYou.map((row) => [row.thread.threadId, row.owner?.threadId])).toEqual([
      ["helper", "owner"],
    ]);
    expect(listed.machines[0]?.attention).toBe(1);
    expect(countFleetAttention([machine(laptop, [owner, helper])])).toBe(1);

    // A native helper with no thread of its own still reaches the owner through its parent.
    const unlisted = buildFleetView([machine(laptop, [owner])]);
    expect(unlisted.needsYou.map((row) => [row.thread.threadId, row.thread.attention])).toEqual([
      ["owner", "approval"],
    ]);
  });

  it("counts what waits on the owner across machines", () => {
    expect(
      countFleetAttention([
        machine(laptop, [thread(laptop, "a", { attention: "approval" }), thread(laptop, "b")]),
        machine(box, [fleetThreadFromLinked(box, summary)]),
      ]),
    ).toBe(2);
  });
});

describe("fleetLine", () => {
  const listed: PeerLinkThreadSummary = {
    threadId: ThreadId.make("remote"),
    title: "Remote",
    projectId: null,
    status: "idle",
    providerInstanceId: "claude-team",
    model: "claude-opus-5-5",
    parentThreadId: null,
    relationshipToParent: null,
    delegatedFrom: null,
    pinned: false,
    settled: false,
    blockedOnThreadWait: false,
    backgroundTaskCount: 0,
    pendingRequestCount: 0,
    createdAt: "2026-11-24T08:00:00.000Z",
    updatedAt: "2026-11-24T09:00:00.000Z",
  };

  it("shows what a linked agent last said, or was asked, as plain words", () => {
    expect(
      fleetThreadFromLinked(box, {
        ...listed,
        latestMessage: {
          author: "agent",
          text: "## Done\n- **Opened** [the pull request](https://example.test/12) and `vp test` passes",
        },
      }).line,
    ).toEqual({ kind: "said", text: "Done Opened the pull request and vp test passes" });
    expect(
      fleetThreadFromLinked(box, {
        ...listed,
        latestMessage: { author: "user", text: "Run the nightly build" },
      }).line,
    ).toEqual({ kind: "asked", text: "Run the nightly build" });
    // A machine on an older version lists no message.
    expect(fleetThreadFromLinked(box, listed).line).toBeNull();
  });

  it("names a linked plan limit, even once the chat is settled, and says why a run stopped", () => {
    const limited = fleetThreadFromLinked(box, {
      ...listed,
      status: "failed",
      settled: true,
      latestMessage: { author: "agent", text: "You've hit your weekly limit · resets Nov 27" },
      stop: { usageLimit: true, message: "Rate limit reached." },
    });
    expect(limited).toMatchObject({
      attention: "limit",
      line: { kind: "said", text: "You've hit your weekly limit · resets Nov 27" },
    });
    expect(
      fleetThreadFromLinked(box, {
        ...listed,
        status: "failed",
        stop: { usageLimit: true, message: "Rate limit reached." },
      }).line,
    ).toEqual({ kind: "stopped", text: "Rate limit reached." });

    const broke = fleetThreadFromLinked(box, {
      ...listed,
      status: "failed",
      latestMessage: { author: "agent", text: "Running the migration" },
      stop: { usageLimit: false, message: "The provider closed the connection." },
    });
    expect(broke).toMatchObject({
      attention: "stopped",
      line: { kind: "stopped", text: "The provider closed the connection." },
    });
    // A run that went on after a failure is no longer stopped by it.
    expect(
      fleetThreadFromLinked(box, {
        ...listed,
        status: "running",
        stop: { usageLimit: true, message: "Rate limit reached." },
      }).attention,
    ).toBeNull();
  });

  it("names when a connected plan resets, and otherwise uses the message read for the row", () => {
    const shell = (runtime: Record<string, unknown> | null) =>
      ({
        environmentId: laptop,
        id: ThreadId.make("local"),
        title: "Local",
        providerInstanceId: "claude-team",
        modelSelection: { instanceId: "claude-team", model: "claude-opus-5-5" },
        lineage: { parentThreadId: null, relationshipToParent: null },
        runtime:
          runtime === null
            ? null
            : {
                activeRunId: null,
                providerInstanceId: "claude-team",
                providerName: null,
                lastError: null,
                updatedAt: "2026-11-24T09:00:00.000Z",
                ...runtime,
              },
        latestRun: null,
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        pendingSubagentRequest: null,
        interactionMode: "default",
        lastVisitedAt: null,
        pinnedAt: null,
        settledAt: null,
        settledOverride: null,
        archivedAt: null,
        deletedAt: null,
        updatedAt: "2026-11-24T09:00:00.000Z",
      }) as unknown as Parameters<typeof fleetThreadFromShell>[0];
    const said = { author: "agent", text: "Checking the changelog" } as const;

    const limited = fleetThreadFromShell(
      shell({
        status: "failed",
        lastError: "Plan limit reached",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: "2026-11-27T00:00:00.000Z",
      }),
    );
    expect(limited.attention).toBe("limit");
    expect(fleetLine(limited, said)).toEqual({ kind: "resets", at: "2026-11-27T00:00:00.000Z" });

    const broke = fleetThreadFromShell(
      shell({ status: "failed", lastError: "The provider closed\nthe connection." }),
    );
    expect(broke.attention).toBe("stopped");
    expect(fleetLine(broke, said)).toEqual({
      kind: "stopped",
      text: "The provider closed the connection.",
    });

    const quiet = fleetThreadFromShell(shell(null));
    expect(fleetLine(quiet, said)).toEqual({ kind: "said", text: "Checking the changelog" });
    expect(fleetLine(quiet, { author: "user", text: "Tidy the docs" })).toEqual({
      kind: "asked",
      text: "Tidy the docs",
    });
    expect(fleetLine(quiet, undefined)).toBeNull();
    expect(fleetLine(quiet, { author: "agent", text: "**`  `**" })).toBeNull();
  });

  it("keeps the words of a line and drops its markdown", () => {
    expect(plainLine("1. Bump the *version* to 2.0 — see #12")).toBe(
      "1. Bump the *version* to 2.0 — see #12",
    );
    expect(plainLine("> Quoted\n\n* item")).toBe("Quoted item");
  });
});
