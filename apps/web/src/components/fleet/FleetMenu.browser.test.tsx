import "~/index.css";

import {
  EnvironmentId,
  type OrchestrationV2ThreadLine,
  type PeerLinkThreadSummary,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../../test/render";
import {
  type FleetMachine,
  type FleetThread,
  fleetLine,
  fleetThreadFromLinked,
} from "./fleet.logic";

const state = vi.hoisted(() => ({
  machines: [] as ReadonlyArray<FleetMachine>,
  messages: new Map<string, OrchestrationV2ThreadLine>(),
}));

vi.mock("./useFleet", () => ({
  useFleetMachines: () => state.machines,
  useFleetLine: (thread: FleetThread) => fleetLine(thread, state.messages.get(thread.threadId)),
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: (select: (settings: { timestampFormat: "24-hour" }) => unknown) =>
    select({ timestampFormat: "24-hour" }),
}));

import { FleetButton } from "./FleetMenu";

const NOW = Date.parse("2026-11-24T18:00:00.000Z");
const laptop = EnvironmentId.make("environment-laptop");
const box = EnvironmentId.make("environment-box");

const local = (id: string, fields: Partial<FleetThread>): FleetThread => ({
  environmentId: laptop,
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
  updatedAt: new Date(NOW).toISOString(),
  line: null,
  ...fields,
});

const listed = (id: string, fields: Partial<PeerLinkThreadSummary>) =>
  fleetThreadFromLinked(box, {
    threadId: ThreadId.make(id),
    title: id,
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
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...fields,
  });

it("names a plan limit on every machine, with what each agent is doing", async () => {
  using _clock = fakeTimers();
  vi.setSystemTime(NOW);
  await page.viewport(1440, 900);
  state.messages = new Map([
    [
      "Release notes",
      { author: "agent", text: "Drafting the notes for 2.4 from the merged pull requests" },
    ],
    ["Docs cleanup", { author: "user", text: "Tidy the docs" }],
  ]);
  state.machines = [
    {
      environmentId: laptop,
      label: "Studio laptop",
      reach: { kind: "connected" },
      state: "ready",
      error: null,
      threads: [
        local("Release notes", { activity: "working" }),
        local("Weekly report", {
          attention: "limit",
          line: { kind: "resets", at: new Date(NOW + 54 * 3_600_000).toISOString() },
        }),
        local("Docs cleanup", {}),
      ],
    },
    {
      environmentId: box,
      label: "Build box",
      reach: { kind: "linked", viaEnvironmentId: laptop },
      state: "ready",
      error: null,
      threads: [
        listed("Nightly build", {
          status: "failed",
          settled: true,
          latestMessage: { author: "agent", text: "You've hit your weekly limit · resets Friday" },
          stop: { usageLimit: true, message: "Rate limit reached. Try again later." },
        }),
        listed("Schema migration", {
          status: "failed",
          latestMessage: { author: "agent", text: "Running the migration" },
          stop: { usageLimit: false, message: "The provider closed the connection." },
        }),
      ],
    },
  ];
  await using screen = await render(<FleetButton onBackdrop={false} />);
  await screen.getByRole("button", { name: "Fleet: 3 need you" }).click();

  const needsYou = page.getByRole("region", { name: "Needs you" });
  await expect.element(needsYou.getByText("Plan limit hit").nth(1)).toBeVisible();
  await expect.element(needsYou.getByText(/^Plan resets /)).toBeVisible();
  // A linked machine's limit says so, not "Stopped", even after its chat was settled.
  await expect
    .element(needsYou.getByText("You've hit your weekly limit · resets Friday"))
    .toBeVisible();
  await expect.element(needsYou.getByText("Stopped")).toBeVisible();
  await expect.element(needsYou.getByText("The provider closed the connection.")).toBeVisible();

  const studio = page.getByRole("region", { name: "Studio laptop" });
  await expect
    .element(studio.getByText("Drafting the notes for 2.4 from the merged pull requests"))
    .toBeVisible();
  await expect.element(studio.getByText("Asked: Tidy the docs")).toBeVisible();
});
