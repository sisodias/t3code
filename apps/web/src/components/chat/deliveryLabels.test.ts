import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { steerMarkerLabel, waitingMessageStatus } from "./deliveryLabels";

// The source-language gt: fills {name} placeholders and ignores $context.
const gt = ((message: string, options?: Record<string, unknown>) =>
  message.replace(/\{(\w+)\}/g, (_, name: string) => String(options?.[name]))) as Parameters<
  typeof waitingMessageStatus
>[1];

describe("delivery labels", () => {
  it("calls a message held for a starting turn sent, not queued", () => {
    const status = waitingMessageStatus({ steerWhenReadyRunId: RunId.make("run:starting") }, gt);
    expect(status.queued).toBe(false);
    expect(status.label).not.toMatch(/queued/i);
    expect(status.label).toBe("Sent · lands when the turn starts");
  });

  it("says queued, with the reason, only for a message kept as a new turn", () => {
    expect(waitingMessageStatus({ freshContext: true }, gt)).toMatchObject({
      queued: true,
      label: "Queued · fresh session",
    });
    expect(
      waitingMessageStatus(
        { queueReason: "this provider cannot take a message during a turn." },
        gt,
      ),
    ).toMatchObject({
      queued: true,
      label: "Queued",
      detail: "Not sent: this provider cannot take a message during a turn.",
    });
    expect(waitingMessageStatus(undefined, gt).queued).toBe(true);
  });

  it("says an unread steer is sent and lands after the current step", () => {
    const marker = steerMarkerLabel({ intent: "steer", unread: true }, gt);
    expect(marker.label).toBe("Sent · lands after the current step");
    expect(marker.label).not.toMatch(/waiting/i);
    expect(steerMarkerLabel({ intent: "steer", unread: false }, gt).label).toBe("Steer");
  });
});
