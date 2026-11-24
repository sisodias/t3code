import { useAtomValue } from "@effect/atom-react";
import { offersLinkedEnvironments } from "@t3tools/client-runtime/link-request";
import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMessages } from "gt-react";

import { useQuietThreadShells } from "../../state/entities";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { formatEnvironmentQueryError } from "../../state/query";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentsWithScope } from "../../state/session";
import {
  type FleetLine,
  fleetLine,
  type FleetMachine,
  type FleetReach,
  type FleetThread,
  fleetThreadFromLinked,
  fleetThreadFromShell,
  isFleetShell,
} from "./fleet.logic";

const noLineRead = Atom.make(null).pipe(Atom.withLabel("fleet:no-line-read"));

/**
 * A row's line. A connected machine's thread list carries no message text, so a row on show
 * reads its thread's newest message, again while it stays on show; a linked list carries it.
 */
export function useFleetLine(thread: FleetThread, reach: FleetReach | undefined): FleetLine | null {
  const reads = thread.line === null && reach?.kind === "connected";
  const result = useAtomValue(
    reads
      ? orchestrationEnvironment.threadLines({
          environmentId: thread.environmentId,
          input: { threadIds: [thread.threadId] },
        })
      : noLineRead,
  );
  return fleetLine(thread, result?._tag === "Success" ? result.value[thread.threadId] : undefined);
}

const linkNamesAtom = environmentAtomList("fleet:link-names", (environmentId) =>
  peerLinkEnvironment.names({ environmentId, input: {} }),
);

/** A linked machine and the connected one whose link reads it. */
type LinkedPair = readonly [via: EnvironmentId, linked: EnvironmentId];

/** Every linked machine's threads, keyed by its pairs so equal lists share one read. */
const linkedThreadsAtom = Atom.family((key: string) => {
  const pairs = key === "" ? [] : (JSON.parse(key) as ReadonlyArray<LinkedPair>);
  return Atom.make((get) =>
    pairs.map(([via, linked]) =>
      get(peerLinkEnvironment.threads({ environmentId: via, input: { environmentId: linked } })),
    ),
  ).pipe(Atom.withLabel(`fleet:linked-threads:${key}`));
});

/**
 * Every machine this client can see: those it is connected to, from their threads here, and
 * those they link to, read over the link. A machine reached both ways is read where connected.
 */
export function useFleetMachines(): ReadonlyArray<FleetMachine> {
  const resolve = useMessages();
  const { environments } = useEnvironments();
  const shells = useQuietThreadShells();

  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  const linkHostCandidates = connected.filter((environment) =>
    offersLinkedEnvironments(environment.serverConfig),
  );
  const readable = useEnvironmentsWithScope(linkHostCandidates, AuthOrchestrationReadScope);
  const hosts = linkHostCandidates
    .filter((environment) => readable.has(environment.environmentId))
    .map((environment) => environment.environmentId);
  const nameLists = useAtomValue(linkNamesAtom(environmentIdsKey(hosts)));

  const connectedIds = new Set(connected.map((environment) => environment.environmentId));
  const claimed = new Set(connectedIds);
  const linked: Array<{ via: EnvironmentId; environmentId: EnvironmentId; label: string }> = [];
  hosts.forEach((via, index) => {
    const names = nameLists[index];
    if (names?._tag !== "Success") return;
    for (const link of names.value.links) {
      if (claimed.has(link.environmentId)) continue;
      claimed.add(link.environmentId);
      linked.push({ via, environmentId: link.environmentId, label: link.label });
    }
  });
  const linkedKey =
    linked.length === 0
      ? ""
      : JSON.stringify(linked.map(({ via, environmentId }): LinkedPair => [via, environmentId]));
  const linkedResults = useAtomValue(linkedThreadsAtom(linkedKey));

  const machines: Array<FleetMachine> = [];
  for (const environment of environments) {
    const { environmentId } = environment;
    if (connectedIds.has(environmentId)) {
      machines.push({
        environmentId,
        label: environment.label,
        reach: { kind: "connected" },
        state: "ready",
        error: null,
        threads: shells
          .filter((shell) => shell.environmentId === environmentId && isFleetShell(shell))
          .map(fleetThreadFromShell),
      });
      continue;
    }
    // A machine its links reach is listed with them below.
    if (claimed.has(environmentId)) continue;
    const phase = environment.connection.phase;
    if (phase === "available") continue;
    machines.push({
      environmentId,
      label: environment.label,
      reach: { kind: "connected" },
      state: phase === "connecting" ? "loading" : "unreachable",
      error: environment.connection.error,
      threads: [],
    });
  }
  linked.forEach(({ via, environmentId, label }, index) => {
    const result = linkedResults[index];
    const reach = { kind: "linked", viaEnvironmentId: via } as const;
    if (result?._tag === "Success") {
      machines.push({
        environmentId,
        label: result.value.label || label,
        reach,
        state: "ready",
        error: null,
        threads: result.value.threads.map((summary) =>
          fleetThreadFromLinked(environmentId, summary),
        ),
      });
      return;
    }
    machines.push({
      environmentId,
      label,
      reach,
      state: result?._tag === "Failure" ? "unreachable" : "loading",
      error: result?._tag === "Failure" ? formatEnvironmentQueryError(result.cause, resolve) : null,
      threads: [],
    });
  });
  return machines;
}
