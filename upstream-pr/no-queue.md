Title: fix(orchestration): messages sent to a busy thread join the running turn instead of queuing

## Problem

A message sent to a thread whose turn is running waits for the whole turn to end before the agent sees it, unless the sender asks for `steer`:

- `t3_thread_send` with `mode: "queue"`, `t3 thread send`, and scheduled tasks start a new turn after the current one. On a long agent turn that is hours; one SISO thread waited 16 hours.
- An `auto` send that arrives while the run is still preparing or starting is queued behind the whole turn, although the turn has not read anything yet.
- The UI calls all of these "Queued", with no reason, so nobody can tell a message that will land in a minute from one that waits for the end.

Since #39018, a Claude steer waits for the step boundary (priority `"next"`) and never cancels a pending tool call, so joining the running turn is safe for Claude as well as Codex.

## Change

No message waits for a turn to end unless it has to start its own turn.

- **Send modes.** `queue` delivers like `auto`: into the running turn after its current step. Four cases still start their own turn after the current one, on purpose: `freshContext` (self-compaction relies on it), a send with `outputSchema` (it asks for a result), `restart`, and `/compact` or `/logout` (the provider runs those only as their own turn). The MCP send result carries a `note` that says which happened.
- **Starting runs.** An automatic message sent while the run is preparing or starting is held for that run (`steerWhenReadyRunId`) and enters its turn as soon as the turn runs. When the provider cannot take a message before its turn starts, or the sender's limits forbid joining a turn whose modes are not set yet, it queues as today and the run says why.
- **Queue reasons.** A message that still queues records `queueReason` on its run, for example "the turn was stopped; this starts the next one."
- **Automatic Claude deliveries.** A delegated child's completion and a scheduled message steer a running Claude parent at the step boundary like a user steer: no pending tool is cancelled, and no notice waits for its own turn.
- **CLI.** `t3 thread send` printed "Queued." for every message that made a run. It now prints the server's note, so a message held for a starting turn reads as sent.
- **Labels (all locales).** An unread steer reads "Sent · lands after the current step"; a held message reads "Sent · lands when the turn starts"; "Queued" appears only for the kept cases, with the reason in its tooltip. The queued-runs control's accessible label says which messages are not sent yet.

`agentContextBudget.json` grows by 289 bytes for the send mode's longer description.

## Verification

Tests that fail on the nightly and pass with this change:

- `CommandPolicy.test.ts`: delivery intent for preparing, starting, running and waiting runs, and for providers that cannot steer.
- `SteeringCompletion.integration.test.ts`: a queue-mode send joins the running turn; an automatic message sent while the run is preparing or starting enters its turn as soon as it runs; a provider that cannot take mid-turn messages keeps today's queue with a reason.
- `ClaudeAutomaticDelivery.integration.test.ts`: every automatic delivery, scheduled messages included, joins the running Claude turn with priority `"next"` and starts no extra run.
- `ThreadManagementService.test.ts`, `OrchestratorMcpToolkit.integration.test.ts`, `cli/thread.test.ts`: send modes, the `note`, and the CLI output.
- `deliveryLabels.test.ts`: the labels above.

SISO has run this change since 19 Nov 2026 on its daily T3. A message sent with `t3 thread send` into a running turn reaches the agent after its current step, and the agent answers it in the same turn.
