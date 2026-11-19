import type { OrchestrationV2Run } from "@t3tools/contracts";
import type { useGT } from "gt-react";

type GT = ReturnType<typeof useGT>;

interface WaitingMessageStatus {
  /** True only for a message kept as a new turn: it has not been sent to the agent. */
  readonly queued: boolean;
  readonly label: string;
  readonly detail: string;
}

/**
 * What a message waiting below the timeline says. "Queued" is only for a message kept as a new
 * turn (a fresh session, /compact, a message someone queued on purpose) or one that could not
 * join the turn, with the reason. A message held for a turn that is still starting is sent.
 */
export function waitingMessageStatus(
  run: Pick<OrchestrationV2Run, "steerWhenReadyRunId" | "queueReason" | "freshContext"> | undefined,
  gt: GT,
): WaitingMessageStatus {
  if (run?.steerWhenReadyRunId !== undefined) {
    return {
      queued: false,
      label: gt("Sent · lands when the turn starts"),
      detail: gt("Sent. The turn is still starting; this message enters it as soon as it runs."),
    };
  }
  if (run?.freshContext === true) {
    return {
      queued: true,
      label: gt("Queued · fresh session"),
      detail: gt("Starts its own session after the current turn."),
    };
  }
  const label = gt("Queued", { $context: "a message that waits for the next turn" });
  if (run?.queueReason !== undefined) {
    return { queued: true, label, detail: gt("Not sent: {reason}", { reason: run.queueReason }) };
  }
  return { queued: true, label, detail: gt("Starts after the current turn.") };
}

/** The marker on a message that steered the running turn. */
export function steerMarkerLabel(
  input: {
    readonly intent: "steer" | "promoted_queued_to_steer";
    readonly unread: boolean;
  },
  gt: GT,
): { readonly label: string; readonly detail: string } {
  if (input.unread) {
    return {
      label: gt("Sent · lands after the current step"),
      detail: gt(
        "Sent into the running turn. The agent reads it after its current step; nothing running is cancelled.",
      ),
    };
  }
  return {
    label: gt("Steer", { $context: "noun, a message that steers the running turn" }),
    detail:
      input.intent === "promoted_queued_to_steer"
        ? gt("Originally queued, then promoted to steer the active turn")
        : gt("Steered the active turn"),
  };
}
