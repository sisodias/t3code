import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import {
  CableIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  LoaderCircleIcon,
  RadarIcon,
  ServerIcon,
  UnplugIcon,
} from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { linkedThreadRouteParams } from "../../linkedThreadSurface";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import {
  buildFleetView,
  countFleetAttention,
  type FleetActivity,
  type FleetAttention,
  type FleetMachine,
  type FleetMachineView,
  type FleetNode,
  type FleetReach,
  type FleetThread,
} from "./fleet.logic";
import { useFleetMachines } from "./useFleet";

type Gt = ReturnType<typeof useGT>;

interface StatusLook {
  readonly label: string;
  readonly dot: string;
  readonly text: string;
  readonly pulse?: boolean;
}

function attentionLook(attention: FleetAttention, gt: Gt): StatusLook {
  switch (attention) {
    case "approval":
      return {
        label: gt("Needs approval"),
        dot: "bg-amber-500 dark:bg-amber-300/90",
        text: "text-amber-600 dark:text-amber-300/90",
      };
    case "question":
      return {
        label: gt("Asks a question"),
        dot: "bg-indigo-500 dark:bg-indigo-300/90",
        text: "text-indigo-600 dark:text-indigo-300/90",
      };
    case "request":
      return {
        label: gt("Waiting for your answer"),
        dot: "bg-amber-500 dark:bg-amber-300/90",
        text: "text-amber-600 dark:text-amber-300/90",
      };
    case "guest":
      return { label: gt("Guest message"), dot: "bg-guest", text: "text-guest-foreground" };
    case "limit":
      return {
        label: gt("Plan limit hit"),
        dot: "bg-red-500 dark:bg-red-300/90",
        text: "text-red-600 dark:text-red-300/90",
      };
    case "stopped":
      return {
        label: gt("Stopped", { $context: "an agent's run ended with an error" }),
        dot: "bg-red-500 dark:bg-red-300/90",
        text: "text-red-600 dark:text-red-300/90",
      };
  }
}

function activityLook(activity: FleetActivity, gt: Gt): StatusLook {
  switch (activity) {
    case "preparing":
      return {
        label: gt("Starting", { $context: "an agent's run is starting" }),
        dot: "bg-sky-500 dark:bg-sky-300/80",
        text: "text-sky-600 dark:text-sky-300/80",
        pulse: true,
      };
    case "working":
      return {
        label: gt("Working"),
        dot: "bg-sky-500 dark:bg-sky-300/80",
        text: "text-sky-600 dark:text-sky-300/80",
        pulse: true,
      };
    case "waiting":
      return {
        label: gt("Waiting", { $context: "an agent waits on another agent or task" }),
        dot: "bg-muted-foreground/70",
        text: "text-muted-foreground",
      };
    case "idle":
      return {
        label: gt("Idle", { $context: "an agent has nothing running" }),
        dot: "bg-muted-foreground/30",
        text: "text-muted-foreground/80",
      };
  }
}

const statusLook = (thread: FleetThread, gt: Gt) =>
  thread.attention === null
    ? activityLook(thread.activity, gt)
    : attentionLook(thread.attention, gt);

function StatusChip({ thread }: { readonly thread: FleetThread }) {
  const gt = useGT();
  const look = statusLook(thread, gt);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-2xs", look.text)}>
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", look.dot, look.pulse && "animate-pulse")}
      />
      {look.label}
    </span>
  );
}

/** Opens a thread where it lives: here when connected, else read through the link. */
function useOpenFleetThread(reachById: ReadonlyMap<EnvironmentId, FleetReach>, close: () => void) {
  const navigate = useNavigate();
  return (thread: FleetThread) => {
    const reach = reachById.get(thread.environmentId);
    close();
    if (reach?.kind === "linked") {
      void navigate({
        to: "/linked/$viaEnvironmentId/$linkedEnvironmentId/$linkedThreadId",
        params: linkedThreadRouteParams({
          viaEnvironmentId: reach.viaEnvironmentId,
          environmentId: thread.environmentId,
          threadId: thread.threadId,
        }),
      });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.threadId)),
    });
  };
}

function ThreadMeta({
  thread,
  machineLabel,
  nowMs,
}: {
  readonly thread: FleetThread;
  readonly machineLabel: string | null;
  readonly nowMs: number;
}) {
  const resolve = useMessages();
  const parts = [
    machineLabel,
    thread.plan,
    thread.model,
    formatRelativeTimeLabel(thread.updatedAt, nowMs, resolve),
  ].filter((part): part is string => part !== null && part !== "");
  return (
    <span className="min-w-0 truncate text-2xs text-muted-foreground">{parts.join(" · ")}</span>
  );
}

function NodeRow({
  node,
  ownerMachine,
  labelById,
  expanded,
  onToggle,
  onOpen,
  nowMs,
}: {
  readonly node: FleetNode;
  readonly ownerMachine: EnvironmentId;
  readonly labelById: ReadonlyMap<EnvironmentId, string>;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly onOpen: (thread: FleetThread) => void;
  readonly nowMs: number;
}) {
  const gt = useGT();
  const { thread } = node;
  const isOpen = expanded.has(node.key);
  const hasChildren = node.children.length > 0 || node.hiddenChildren > 0;
  // A lane another machine runs says where; the rest run on the owner's machine.
  const machineLabel =
    thread.environmentId === ownerMachine
      ? null
      : (labelById.get(thread.environmentId) ?? thread.environmentId);
  const under = [
    node.lanes > 0
      ? gt("{count, plural, one {{count} lane} other {{count} lanes}}", { count: node.lanes })
      : null,
    node.helpers > 0
      ? gt("{count, plural, one {{count} helper} other {{count} helpers}}", {
          count: node.helpers,
        })
      : null,
    node.working > 0 ? gt("{count} working under it", { count: node.working }) : null,
  ].filter((part): part is string => part !== null);
  return (
    <li data-fleet-node={node.kind}>
      <div
        className="group/fleet-row flex items-start gap-1 rounded-md pr-2 hover:bg-accent/60"
        style={{ paddingLeft: `${node.depth * 1.25}rem` }}
      >
        {hasChildren ? (
          <Button
            aria-expanded={isOpen}
            aria-label={
              isOpen
                ? gt("Hide what runs under {title}", { title: thread.title })
                : gt("Show what runs under {title}", { title: thread.title })
            }
            className="mt-1.5 shrink-0"
            onClick={() => onToggle(node.key)}
            size="icon-micro"
            variant="ghost"
          >
            <ChevronRightIcon className={cn("transition-transform", isOpen && "rotate-90")} />
          </Button>
        ) : (
          <span aria-hidden className="w-5 shrink-0" />
        )}
        <button
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm py-1.5 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => onOpen(thread)}
          type="button"
        >
          <span className="flex min-w-0 items-center gap-2">
            {node.kind === "owner" ? null : (
              <span className="shrink-0 rounded-sm bg-muted px-1 text-3xs font-medium text-muted-foreground uppercase">
                {node.kind === "helper"
                  ? gt("Helper", { $context: "a sub-agent under an agent chat" })
                  : gt("Lane", { $context: "a forked or delegated agent chat" })}
              </span>
            )}
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {thread.title}
            </span>
            <span className="ml-auto">
              <StatusChip thread={thread} />
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <ThreadMeta machineLabel={machineLabel} nowMs={nowMs} thread={thread} />
            {under.length > 0 ? (
              <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                {under.join(" · ")}
              </span>
            ) : null}
          </span>
        </button>
      </div>
      {isOpen && hasChildren ? (
        <ul>
          {node.children.map((child) => (
            <NodeRow
              expanded={expanded}
              key={child.key}
              labelById={labelById}
              node={child}
              nowMs={nowMs}
              onOpen={onOpen}
              onToggle={onToggle}
              ownerMachine={ownerMachine}
            />
          ))}
          {node.hiddenChildren > 0 ? (
            <li
              className="py-1 text-2xs text-muted-foreground"
              style={{ paddingLeft: `${(node.depth + 1) * 1.25 + 1.5}rem` }}
            >
              {gt("{count, plural, one {and {count} quiet one} other {and {count} quiet ones}}", {
                count: node.hiddenChildren,
              })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function MachineSection({
  machine,
  labelById,
  expanded,
  onToggle,
  onOpen,
  nowMs,
}: {
  readonly machine: FleetMachineView;
  readonly labelById: ReadonlyMap<EnvironmentId, string>;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly onOpen: (thread: FleetThread) => void;
  readonly nowMs: number;
}) {
  const gt = useGT();
  const reach =
    machine.reach.kind === "linked"
      ? gt("Linked through {name}", {
          name: labelById.get(machine.reach.viaEnvironmentId) ?? machine.reach.viaEnvironmentId,
        })
      : gt("Connected", { $context: "this app is connected to the machine" });
  const counts = [
    machine.working > 0 ? gt("{count} working", { count: machine.working }) : null,
    machine.attention > 0
      ? gt("{count, plural, one {{count} needs you} other {{count} need you}}", {
          count: machine.attention,
        })
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <section
      aria-label={machine.label}
      className="border-t border-border/60 px-2 pt-2 pb-1 first:border-t-0"
      data-fleet-machine={machine.state}
    >
      <header className="flex items-center gap-2 px-1 pb-1">
        {machine.state === "unreachable" ? (
          <UnplugIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
        ) : machine.reach.kind === "linked" ? (
          <CableIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ServerIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-xs font-semibold text-foreground">{machine.label}</span>
        <span className="truncate text-2xs text-muted-foreground">{reach}</span>
        {counts.length > 0 ? (
          <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
            {counts.join(" · ")}
          </span>
        ) : null}
      </header>
      {machine.state === "unreachable" ? (
        <p className="px-1 pb-1.5 text-xs text-destructive">
          {machine.error === null
            ? gt("This machine cannot be reached.")
            : gt("This machine cannot be reached: {reason}", { reason: machine.error })}
        </p>
      ) : machine.state === "loading" ? (
        <p className="flex items-center gap-1.5 px-1 pb-1.5 text-xs text-muted-foreground">
          <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
          {gt("Reading its agents…")}
        </p>
      ) : machine.owners.length === 0 ? (
        <p className="px-1 pb-1.5 text-xs text-muted-foreground">{gt("No agent chats here.")}</p>
      ) : (
        <ul>
          {machine.owners.map((node) => (
            <NodeRow
              expanded={expanded}
              key={node.key}
              labelById={labelById}
              node={node}
              nowMs={nowMs}
              onOpen={onOpen}
              onToggle={onToggle}
              ownerMachine={machine.environmentId}
            />
          ))}
        </ul>
      )}
      {machine.hiddenOwners > 0 ? (
        <p className="px-1 pb-1 pl-7 text-2xs text-muted-foreground">
          {gt("{count, plural, one {and {count} quiet chat} other {and {count} quiet chats}}", {
            count: machine.hiddenOwners,
          })}
        </p>
      ) : null}
    </section>
  );
}

/** Every machine's agents in one place: what waits on you, then each machine's owner chats. */
function FleetPanel({
  machines,
  onClose,
}: {
  readonly machines: ReadonlyArray<FleetMachine>;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00Z`);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const view = buildFleetView(machines);
  const labelById = new Map(machines.map((machine) => [machine.environmentId, machine.label]));
  const reachById = new Map(machines.map((machine) => [machine.environmentId, machine.reach]));
  const open = useOpenFleetThread(reachById, onClose);
  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const summary = [
    gt("{count, plural, one {{count} machine} other {{count} machines}}", {
      count: machines.length,
    }),
    gt("{count} working", { count: view.working }),
    view.unreachable > 0 ? gt("{count} unreachable", { count: view.unreachable }) : null,
  ].filter((part): part is string => part !== null);

  return (
    <div
      className="flex max-h-[min(75vh,44rem)] w-[min(32rem,calc(100vw-2rem))] flex-col"
      data-fleet-panel=""
    >
      <div className="flex items-baseline gap-2 border-b border-border/60 px-3 py-2.5">
        <PopoverTitle>{gt("Fleet")}</PopoverTitle>
        <span className="truncate text-xs text-muted-foreground">{summary.join(" · ")}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section
          aria-label={gt("Needs you")}
          className="border-b border-border/60 px-2 py-2"
          data-fleet-needs-you={view.needsYou.length}
        >
          <h3 className="px-1 pb-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
            {gt("Needs you")}
          </h3>
          {view.needsYou.length === 0 ? (
            <p className="flex items-center gap-1.5 px-1 pb-1 text-xs text-muted-foreground">
              <CircleCheckIcon aria-hidden className="size-3.5 text-success" />
              {gt("Nothing waits on you.")}
            </p>
          ) : (
            <ul>
              {view.needsYou.map((row) => (
                <li key={row.key}>
                  <button
                    className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1 py-1.5 text-left outline-hidden hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    onClick={() => open(row.thread)}
                    type="button"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-foreground">
                        {row.thread.title}
                      </span>
                      <span className="ml-auto">
                        <StatusChip thread={row.thread} />
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <ThreadMeta
                        machineLabel={row.machineLabel}
                        nowMs={nowMs}
                        thread={row.thread}
                      />
                      {row.owner === null ? null : (
                        <span className="ml-auto min-w-0 shrink truncate text-2xs text-muted-foreground">
                          {gt("under {owner}", { owner: row.owner.title })}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {view.machines.map((machine) => (
          <MachineSection
            expanded={expanded}
            key={machine.environmentId}
            labelById={labelById}
            machine={machine}
            nowMs={nowMs}
            onOpen={open}
            onToggle={toggle}
          />
        ))}
      </div>
    </div>
  );
}

/** The top-bar button that opens the fleet; its badge counts what waits on you anywhere. */
export function FleetButton({ onBackdrop }: { readonly onBackdrop: boolean }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const machines = useFleetMachines();
  const attention = countFleetAttention(machines);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={
              attention > 0
                ? gt(
                    "{count, plural, one {Fleet: {count} needs you} other {Fleet: {count} need you}}",
                    {
                      count: attention,
                    },
                  )
                : gt("Fleet: every machine's agents")
            }
            className={cn(
              "shrink-0 [-webkit-app-region:no-drag]",
              onBackdrop && "relative top-auto translate-y-0",
            )}
            data-fleet-button=""
            size="compact"
            variant={onBackdrop ? "media-navigation" : "ghost"}
          />
        }
      >
        <RadarIcon aria-hidden />
        <span>{gt("Fleet")}</span>
        {attention > 0 ? (
          <span className="rounded-full bg-warning px-1.5 text-3xs leading-4 font-semibold text-white tabular-nums">
            {attention}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" padding="none">
        <FleetPanel machines={machines} onClose={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  );
}
