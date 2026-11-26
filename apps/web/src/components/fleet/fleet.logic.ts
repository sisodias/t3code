import type { EnvironmentId, PeerLinkThreadSummary, ThreadId } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarRowStatus } from "../Sidebar.logic";

/** Why a thread waits on its owner, most urgent first. */
export type FleetAttention =
  | "approval"
  | "question"
  /** A linked machine says a request waits, without saying which kind. */
  | "request"
  | "guest"
  | "limit"
  | "stopped";

/** What a thread is doing when nothing waits on its owner. */
export type FleetActivity = "preparing" | "working" | "waiting" | "idle";

export type FleetThreadKind = "owner" | "lane" | "helper";

export interface FleetThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** One thread on one machine, in the terms the fleet shows whichever way it was read. */
export interface FleetThread extends FleetThreadRef {
  readonly title: string;
  readonly attention: FleetAttention | null;
  /**
   * What a helper under this thread waits on, as the thread reports it. The fleet shows it on the
   * helper, and on this thread only when no thread under it shows one.
   */
  readonly helperAttention: FleetAttention | null;
  readonly activity: FleetActivity;
  /** The provider instance the thread runs on, which is the plan it bills to. */
  readonly plan: string | null;
  readonly model: string | null;
  /** A thread on the same machine this one was forked or spawned from. */
  readonly parentThreadId: ThreadId | null;
  readonly relationship: "fork" | "subagent" | null;
  /** The thread on another machine whose agent delegated this one. */
  readonly delegatedFrom: FleetThreadRef | null;
  readonly pinned: boolean;
  readonly settled: boolean;
  readonly backgroundTaskCount: number;
  readonly updatedAt: string;
}

/** How this client reaches a machine: connected to it, or through another machine's link. */
export type FleetReach =
  | { readonly kind: "connected" }
  | { readonly kind: "linked"; readonly viaEnvironmentId: EnvironmentId };

export type FleetMachineState = "ready" | "loading" | "unreachable";

export interface FleetMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reach: FleetReach;
  readonly state: FleetMachineState;
  /** Why an unreachable machine cannot be read, as its connection or link said. */
  readonly error: string | null;
  readonly threads: ReadonlyArray<FleetThread>;
}

export interface FleetNode {
  readonly key: string;
  readonly thread: FleetThread;
  readonly kind: FleetThreadKind;
  readonly depth: number;
  /** Lanes and helpers under this thread, those under way first. */
  readonly children: ReadonlyArray<FleetNode>;
  /** Quiet lanes and helpers left out of `children`. */
  readonly hiddenChildren: number;
  /** This thread or one under it waits on its owner or is under way. */
  readonly live: boolean;
  readonly lanes: number;
  readonly helpers: number;
  /** Threads under this one, at any depth, that are under way. */
  readonly working: number;
  /** Threads under this one, at any depth, that wait on their owner. */
  readonly attention: number;
}

export interface FleetMachineView extends Omit<FleetMachine, "threads"> {
  readonly owners: ReadonlyArray<FleetNode>;
  /** Quiet owner chats left out of `owners`. */
  readonly hiddenOwners: number;
  /** Threads running on this machine, wherever their owner is. */
  readonly working: number;
  readonly attention: number;
}

export interface FleetNeedsYouRow {
  readonly key: string;
  readonly thread: FleetThread;
  readonly machineLabel: string;
  /** The owner chat the thread sits under, when it is not one itself. */
  readonly owner: FleetThread | null;
}

export interface FleetView {
  readonly needsYou: ReadonlyArray<FleetNeedsYouRow>;
  readonly machines: ReadonlyArray<FleetMachineView>;
  readonly working: number;
  readonly unreachable: number;
}

const FLEET_QUIET_OWNER_LIMIT = 6;
const FLEET_QUIET_CHILD_LIMIT = 4;
/** Lanes of lanes are rare; deeper ones still count, but are not drawn. */
const MAX_DEPTH = 3;

const ATTENTION_ORDER: Record<FleetAttention, number> = {
  approval: 0,
  question: 1,
  request: 2,
  guest: 3,
  limit: 4,
  stopped: 5,
};

const fleetThreadKey = (ref: FleetThreadRef) => `${ref.environmentId}\n${ref.threadId}`;

const isUnderWay = (thread: FleetThread) => thread.activity !== "idle";

const isLive = (thread: FleetThread) => thread.attention !== null || isUnderWay(thread);

/** Waiting on the owner first, then under way, then pinned, then latest. */
function compareThreads(left: FleetThread, right: FleetThread): number {
  const leftAttention = left.attention === null ? 99 : ATTENTION_ORDER[left.attention];
  const rightAttention = right.attention === null ? 99 : ATTENTION_ORDER[right.attention];
  if (leftAttention !== rightAttention) return leftAttention - rightAttention;
  const underWay = Number(isUnderWay(right)) - Number(isUnderWay(left));
  if (underWay !== 0) return underWay;
  return right.updatedAt.localeCompare(left.updatedAt);
}

function compareNodes(left: FleetNode, right: FleetNode): number {
  const live = Number(right.live) - Number(left.live);
  if (live !== 0) return live;
  if (left.live) {
    const attention = Number(right.attention > 0) - Number(left.attention > 0);
    if (attention !== 0) return attention;
  }
  const pinned = Number(right.thread.pinned) - Number(left.thread.pinned);
  if (pinned !== 0) return pinned;
  return compareThreads(left.thread, right.thread);
}

/**
 * Every machine's threads as owner chats with their lanes and helpers, and above them what
 * waits on the owner. A lane another machine runs for an owner sits under that owner, so an
 * owner shows all its agents wherever they run.
 */
export function buildFleetView(
  machines: ReadonlyArray<FleetMachine>,
  options: { readonly quietOwnerLimit?: number; readonly quietChildLimit?: number } = {},
): FleetView {
  const quietOwnerLimit = options.quietOwnerLimit ?? FLEET_QUIET_OWNER_LIMIT;
  const quietChildLimit = options.quietChildLimit ?? FLEET_QUIET_CHILD_LIMIT;
  const byKey = new Map<string, FleetThread>();
  for (const machine of machines) {
    for (const thread of machine.threads) byKey.set(fleetThreadKey(thread), thread);
  }

  const parentKeyOf = (thread: FleetThread): string | null => {
    if (thread.parentThreadId !== null) {
      const key = fleetThreadKey({
        environmentId: thread.environmentId,
        threadId: thread.parentThreadId,
      });
      if (byKey.has(key)) return key;
    }
    if (thread.delegatedFrom !== null) {
      const key = fleetThreadKey(thread.delegatedFrom);
      if (byKey.has(key)) return key;
    }
    return null;
  };

  const childKeysByKey = new Map<string, Array<string>>();
  const rootKeys: Array<string> = [];
  for (const [key, thread] of byKey) {
    const parent = parentKeyOf(thread);
    // A thread that names itself is drawn as an owner rather than lost.
    if (parent === null || parent === key) {
      rootKeys.push(key);
      continue;
    }
    const siblings = childKeysByKey.get(parent);
    if (siblings === undefined) childKeysByKey.set(parent, [key]);
    else siblings.push(key);
  }

  const attentionBelow = (key: string, seen: Set<string>): boolean =>
    (childKeysByKey.get(key) ?? []).some((childKey) => {
      if (seen.has(childKey)) return false;
      seen.add(childKey);
      return byKey.get(childKey)?.attention != null || attentionBelow(childKey, seen);
    });
  for (const [key, thread] of byKey) {
    if (thread.attention !== null || thread.helperAttention === null) continue;
    if (attentionBelow(key, new Set([key]))) continue;
    byKey.set(key, { ...thread, attention: thread.helperAttention });
  }
  const threadsOf = (keys: ReadonlyArray<string>) =>
    keys.flatMap((key) => {
      const thread = byKey.get(key);
      return thread === undefined ? [] : [thread];
    });
  const childrenByKey = new Map(
    [...childKeysByKey].map(([key, childKeys]) => [key, threadsOf(childKeys)] as const),
  );
  const roots = threadsOf(rootKeys);

  const placed = new Set<string>();
  const ownerOf = new Map<string, FleetThread>();
  const buildNode = (thread: FleetThread, depth: number, owner: FleetThread | null): FleetNode => {
    const key = fleetThreadKey(thread);
    placed.add(key);
    if (owner !== null) ownerOf.set(key, owner);
    const below = (childrenByKey.get(key) ?? []).filter(
      (child) => !placed.has(fleetThreadKey(child)),
    );
    const nodes = below
      .map((child) => buildNode(child, depth + 1, owner ?? thread))
      .toSorted(compareNodes);
    const live = isLive(thread) || nodes.some((node) => node.live);
    const kept: Array<FleetNode> = [];
    let quietKept = 0;
    for (const node of nodes) {
      if (node.live || quietKept < quietChildLimit) {
        if (!node.live) quietKept += 1;
        kept.push(node);
      }
    }
    const visible = depth + 1 >= MAX_DEPTH ? [] : kept;
    return {
      key,
      thread,
      kind:
        depth === 0 ? "owner" : thread.relationship === "subagent" ? "helper" : ("lane" as const),
      depth,
      children: visible,
      hiddenChildren: nodes.length - visible.length,
      live,
      lanes: nodes.filter((node) => node.thread.relationship !== "subagent").length,
      helpers: nodes.filter((node) => node.thread.relationship === "subagent").length,
      working: nodes.reduce((sum, node) => sum + node.working + Number(isUnderWay(node.thread)), 0),
      attention: nodes.reduce(
        (sum, node) => sum + node.attention + Number(node.thread.attention !== null),
        0,
      ),
    };
  };

  const ownersByMachine = new Map<EnvironmentId, Array<FleetNode>>();
  for (const root of roots) {
    const node = buildNode(root, 0, null);
    const owners = ownersByMachine.get(root.environmentId);
    if (owners === undefined) ownersByMachine.set(root.environmentId, [node]);
    else owners.push(node);
  }
  // A loop of parents has no root; its threads still show, each as an owner.
  for (const [key, thread] of byKey) {
    if (placed.has(key)) continue;
    const node = buildNode(thread, 0, null);
    const owners = ownersByMachine.get(thread.environmentId);
    if (owners === undefined) ownersByMachine.set(thread.environmentId, [node]);
    else owners.push(node);
  }

  const labelById = new Map(machines.map((machine) => [machine.environmentId, machine.label]));
  const views = machines.map((machine): FleetMachineView => {
    const owners = (ownersByMachine.get(machine.environmentId) ?? []).toSorted(compareNodes);
    const shown: Array<FleetNode> = [];
    let quietShown = 0;
    for (const owner of owners) {
      if (owner.live || owner.thread.pinned) {
        shown.push(owner);
      } else if (!owner.thread.settled && quietShown < quietOwnerLimit) {
        quietShown += 1;
        shown.push(owner);
      }
    }
    const { threads: _reported, ...rest } = machine;
    const threads = [...byKey.values()].filter(
      (thread) => thread.environmentId === machine.environmentId,
    );
    return {
      ...rest,
      owners: shown,
      hiddenOwners: owners.length - shown.length,
      working: threads.filter(isUnderWay).length,
      attention: threads.filter((thread) => thread.attention !== null).length,
    };
  });

  const needsYou = [...byKey.entries()]
    .filter(([, thread]) => thread.attention !== null)
    .toSorted(([, left], [, right]) => compareThreads(left, right))
    .map(([key, thread]): FleetNeedsYouRow => ({
      key,
      thread,
      machineLabel: labelById.get(thread.environmentId) ?? thread.environmentId,
      owner: ownerOf.get(key) ?? null,
    }));

  return {
    needsYou,
    machines: views,
    working: views.reduce((sum, machine) => sum + machine.working, 0),
    unreachable: views.filter((machine) => machine.state === "unreachable").length,
  };
}

/** How many threads wait on their owner, for the button's badge. */
export function countFleetAttention(machines: ReadonlyArray<FleetMachine>): number {
  return buildFleetView(machines).needsYou.length;
}

type LocalShell = Pick<
  SidebarThreadSummary,
  | "environmentId"
  | "id"
  | "title"
  | "providerInstanceId"
  | "modelSelection"
  | "lineage"
  | "delegatedFrom"
  | "runtime"
  | "latestRun"
  | "blockedOnThreadWait"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "lastVisitedAt"
  | "pendingBackgroundTasks"
  | "pinnedAt"
  | "settledAt"
  | "settledOverride"
  | "archivedAt"
  | "deletedAt"
  | "updatedAt"
>;

/** Side chats and workflow steps belong to another view; archived threads to none. */
export function isFleetShell(shell: LocalShell): boolean {
  return (
    shell.archivedAt === null &&
    shell.deletedAt === null &&
    shell.lineage.sideChat !== true &&
    shell.lineage.workflowStep !== true
  );
}

/** A thread of a machine this client is connected to, as its sidebar row reads it. */
export function fleetThreadFromShell(shell: LocalShell): FleetThread {
  // The helper's own row shows what it waits on; see `helperAttention`.
  const status = resolveSidebarRowStatus({ ...shell, pendingSubagentRequest: null });
  const delegatedFrom = shell.delegatedFrom ?? null;
  const attention: FleetAttention | null =
    status === "approval"
      ? "approval"
      : status === "input"
        ? "question"
        : status === "request"
          ? "guest"
          : status === "limited"
            ? "limit"
            : status === "failed"
              ? "stopped"
              : null;
  const activity: FleetActivity =
    status === "preparing"
      ? "preparing"
      : status === "working"
        ? "working"
        : shell.runtime?.status === "running" && shell.blockedOnThreadWait === true
          ? "waiting"
          : attention !== null &&
              shell.runtime !== null &&
              ["queued", "starting", "running", "waiting"].includes(shell.runtime.status)
            ? "working"
            : "idle";
  return {
    environmentId: shell.environmentId,
    threadId: shell.id,
    title: shell.title,
    attention,
    helperAttention:
      shell.pendingSubagentRequest === "approval"
        ? "approval"
        : shell.pendingSubagentRequest === "user_input"
          ? "question"
          : null,
    activity,
    plan: shell.runtime?.providerInstanceId ?? shell.providerInstanceId,
    model: shell.modelSelection.model,
    parentThreadId: shell.lineage.parentThreadId,
    relationship: shell.lineage.relationshipToParent,
    delegatedFrom:
      delegatedFrom === null
        ? null
        : { environmentId: delegatedFrom.environmentId, threadId: delegatedFrom.threadId },
    pinned: shell.pinnedAt !== null,
    settled: shell.settledOverride === "settled" || shell.settledAt !== null,
    backgroundTaskCount: shell.pendingBackgroundTasks?.length ?? 0,
    updatedAt: shell.updatedAt,
  };
}

/** A thread of a linked machine, as its own list reported it. */
export function fleetThreadFromLinked(
  environmentId: EnvironmentId,
  summary: PeerLinkThreadSummary,
): FleetThread {
  const asks = (summary.pendingRequestCount ?? 0) > 0;
  const attention: FleetAttention | null = asks
    ? "request"
    : summary.status === "failed" && !summary.settled
      ? "stopped"
      : null;
  const activity: FleetActivity =
    summary.status === "preparing"
      ? "preparing"
      : summary.status === "queued" || summary.status === "starting" || summary.status === "running"
        ? "working"
        : summary.status === "waiting"
          ? "waiting"
          : "idle";
  return {
    environmentId,
    threadId: summary.threadId,
    title: summary.title,
    attention,
    helperAttention: null,
    activity,
    plan: summary.providerInstanceId,
    model: summary.model,
    parentThreadId: summary.parentThreadId,
    relationship: summary.relationshipToParent,
    delegatedFrom:
      summary.delegatedFrom === null
        ? null
        : {
            environmentId: summary.delegatedFrom.environmentId,
            threadId: summary.delegatedFrom.threadId,
          },
    pinned: summary.pinned,
    settled: summary.settled,
    backgroundTaskCount: summary.backgroundTaskCount,
    updatedAt: summary.updatedAt,
  };
}
