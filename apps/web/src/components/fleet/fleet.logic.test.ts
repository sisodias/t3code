import { EnvironmentId, type PeerLinkThreadSummary, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFleetView,
  countFleetAttention,
  type FleetMachine,
  type FleetThread,
  fleetThreadFromLinked,
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
