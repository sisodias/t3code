import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { ScenarioError } from "./shell.ts";
import { environmentId, makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

const uuid = Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV4());
const decodeCredential = Schema.decodeUnknownSync(Schema.Struct({ credential: Schema.String }));
const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeEffect(SettingsJson);
const encodeSettings = Schema.encodeEffect(SettingsJson);

/** Supervised mode makes the approval recording wait for an answer; the server outlives the test. */
const superviseThreads = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const settingsPath = (yield* Path.Path).join(T3_HOME, "userdata/settings.json");
  const original = yield* fs.readFileString(settingsPath);
  const settings = yield* decodeSettings(original);
  yield* fs.writeFileString(
    settingsPath,
    yield* encodeSettings({
      ...settings,
      defaultRuntimeMode: "approval-required",
    }),
  );
  return fs.writeFileString(settingsPath, original);
});

// A linked machine's list is read again every 30 seconds, and a failed read takes a while.
const LINKED_READ = { timeout: 90_000 };

/** The request a thread waits on, and its unfinished run. */
const pendingRequest = Effect.fn("scenario.pendingRequest")(function* (
  client: Effect.Success<ReturnType<typeof rpcClient>>,
  threadId: ThreadId,
) {
  const projection = yield* client["orchestration.getThreadProjection"]({ threadId });
  const run = projection.runs.find((candidate) => candidate.completedAt === null);
  const request = projection.runtimeRequests.find((candidate) => candidate.status === "pending");
  if (run?.rootNodeId == null || request === undefined) {
    return yield* new ScenarioError({ message: `${threadId} is not waiting on an approval.` });
  }
  return { projection, run, rootNodeId: run.rootNodeId, request };
});

/**
 * Gives a thread waiting on approval a helper that waits on its own approval, lets the thread go
 * on, then forks lanes from it: an owner with everything a fleet nests under one.
 */
const seedOwner = Effect.fn("scenario.seedOwner")(
  function* (origin: string, ownerId: string, laneTitles: ReadonlyArray<string>) {
    const client = yield* rpcClient(T3_HOME, origin);
    const threadId = ThreadId.make(ownerId);
    const { run, rootNodeId, request } = yield* pendingRequest(client, threadId);
    yield* client["orchestration.dispatchCommand"]({
      type: "delegated_task.request",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(yield* uuid),
      parentThreadId: threadId,
      parentRunId: run.id,
      parentNodeId: rootNodeId,
      task: "Check the changelog lists every fix",
      title: "Check the changelog",
      modelSelection: { ...run.modelSelection, model: "approval" },
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    yield* client["orchestration.dispatchCommand"]({
      type: "runtime-request.respond",
      commandId: CommandId.make(yield* uuid),
      threadId,
      requestId: request.id,
      decision: "accept",
    });
    const lanes: Array<string> = [];
    for (const title of laneTitles) {
      const laneId = ThreadId.make(yield* uuid);
      // A fork needs a finished run, so it is asked again until the approved run ends.
      yield* Effect.gen(function* () {
        yield* client["orchestration.dispatchCommand"]({
          type: "thread.fork",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(yield* uuid),
          sourceThreadId: threadId,
          targetThreadId: laneId,
          sourcePoint: { type: "latest_stable" },
          title,
        });
      }).pipe(Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }));
      lanes.push(laneId);
    }
    // The helper's result wakes the owner; its next turn should not ask again.
    yield* client["orchestration.dispatchCommand"]({
      type: "provider.switch",
      commandId: CommandId.make(yield* uuid),
      threadId,
      modelSelection: { ...run.modelSelection, model: "multi-turn" },
    });
    return lanes;
  },
  Effect.scoped,
  Effect.provide(NodeCrypto.layer),
);

/** Approves the request the owner's helper waits on. */
const approveHelper = Effect.fn("scenario.approveHelper")(
  function* (origin: string, ownerId: string) {
    const client = yield* rpcClient(T3_HOME, origin);
    const owner = yield* client["orchestration.getThreadProjection"]({
      threadId: ThreadId.make(ownerId),
    });
    const helperId = owner.subagents.find((item) => item.childThreadId !== null)?.childThreadId;
    if (helperId == null) return yield* new ScenarioError({ message: "The owner has no helper." });
    const { request } = yield* pendingRequest(client, helperId);
    yield* client["orchestration.dispatchCommand"]({
      type: "runtime-request.respond",
      commandId: CommandId.make(yield* uuid),
      threadId: helperId,
      requestId: request.id,
      decision: "accept",
    });
  },
  Effect.scoped,
  Effect.provide(NodeCrypto.layer),
);

/** Mints a full-access peer-link code on the second server, outside Effect like the HTTP fixture it is. */
async function mintFullAccessCode(host: string): Promise<string> {
  const issued = await runPromise(
    makeState(SECOND_HOME).cli(["auth", "session", "issue", "--token-only"]),
  );
  // @effect-diagnostics-next-line globalFetch:off -- Seeds the real peer link from the scenario's Node fixture.
  const response = await fetch(`${host}/api/auth/pairing-token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${issued.stdout.trim()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ purpose: "peer-link", access: "full-access" }),
  });
  if (!response.ok) throw new Error(`Could not mint a peer-link code: ${response.status}`);
  return decodeCredential(await response.json()).credential;
}

/** Turns linked environments on for both servers and links the first to the second, full access. */
const linkFullAccess = Effect.fn("scenario.linkFullAccess")(function* (
  origin: string,
  host: string,
  pairingCode: string,
) {
  const primary = yield* rpcClient(T3_HOME, origin);
  const remote = yield* rpcClient(SECOND_HOME, host);
  for (const client of [primary, remote]) {
    yield* client["server.updateSettings"]({ patch: { linkedEnvironmentsEnabled: true } });
  }
  yield* remote["server.updateSettings"]({ patch: { defaultRuntimeMode: "approval-required" } });
  yield* primary["peerLinks.link"]({ url: host, pairingCode, access: "full-access" });
}, Effect.scoped);

test(
  "The fleet shows every machine's agents, what waits on you, and opens each chat",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const origin = app.baseUrl ?? "";
    const website = await t3.project("website");
    const restoreSettings = await runPromise(superviseThreads);
    let ownerId = "";
    try {
      ownerId = (
        await t3.thread({
          project: website,
          title: "Release coordinator",
          messages: ["Get the release ready"],
          model: "approval",
        })
      ).threadId;
      await runPromise(seedOwner(origin, ownerId, ["Landing page copy", "Pricing table"]));
      await t3.thread({ project: website, title: "Docs cleanup", messages: ["Tidy the docs"] });
    } finally {
      await runPromise(restoreSettings);
    }

    const fleet = screen.getByRole("button", "Fleet:", { exact: false });
    const panel = screen.getByRole("dialog");
    const needsYou = panel.getByRole("region", "Needs you");
    // The popover fades in with a transition, which screenshots do not stop, so pictures wait it out.
    const panelSettled = () =>
      browser.evaluate(async () => {
        const dialog = document.querySelector('[role="dialog"]');
        const animations = dialog?.getAnimations({ subtree: true }) ?? [];
        await Promise.all(animations.map((animation) => animation.finished));
        return animations.length;
      });
    const server = startSecondServer(origin, { label: "Build box" });
    try {
      const { host } = await server.ready;
      await runPromise(linkFullAccess(origin, host, await mintFullAccessCode(host)));
      const second = makeState(SECOND_HOME).state;
      const scripts = await second.project("build-scripts");
      await second.thread({
        project: scripts,
        title: "Nightly build",
        messages: ["Run the nightly build"],
      });
      const via = await runPromise(environmentId(origin));
      const box = await runPromise(environmentId(host));

      await browser.setViewport({ width: 1440, height: 900 });
      await t3.open();

      // One agent waits on a permission request: the owner's helper, which nobody is looking at.
      // A dev build's first load after an edit can take most of a minute.
      await expect(screen.getByRole("button", "Fleet: 1 needs you")).toBeVisible({
        timeout: 60_000,
      });
      await fleet.tap();
      await expect(panel.getByText("Nightly build", { exact: true })).toBeVisible(LINKED_READ);
      await expect(needsYou.getByText("Needs approval", { exact: true })).toBeVisible();
      await expect(needsYou.getByText("under Release coordinator", { exact: true })).toBeVisible();
      // Each row says what its agent was last asked or said; this machine's lines are read for the rows on show.
      await expect(
        needsYou.getByText("Asked: Check the changelog lists every fix", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await panelSettled();
      await app.screenshot("fleet-permission-waiting");

      await panel.getByRole("button", "Show what runs under Release coordinator").tap();
      await expect(panel.getByText("Pricing table", { exact: true })).toBeVisible();
      await expect(panel.getByText("Landing page copy", { exact: true })).toBeVisible();
      await expect(panel.getByText("Helper", { exact: true })).toBeVisible();
      await panelSettled();
      await app.screenshot("fleet-owner-opened-out");

      await needsYou.getByRole("button", "Check the changelog", { exact: false }).tap();
      await expect(browser).toHaveURL(new RegExp(`^${origin}/${via}/[^/]+$`));
      await expect(
        screen.getByText("Check the changelog lists every fix", { exact: true }).first(),
      ).toBeVisible();
      await app.screenshot("fleet-helper-chat");

      await runPromise(approveHelper(origin, ownerId));
      await expect(screen.getByRole("button", "Fleet: every machine's agents")).toBeVisible({
        timeout: 30_000,
      });
      await fleet.tap();
      await expect(needsYou.getByText("Nothing waits on you.", { exact: true })).toBeVisible();
      await expect(panel.getByText("2 machines · 0 working", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        panel
          .getByRole("button", "Docs cleanup", { exact: false })
          .getByText("first fixture turn complete", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        panel
          .getByRole("region", "Build box")
          .getByText("first fixture turn complete", { exact: true }),
      ).toBeVisible(LINKED_READ);
      await panelSettled();
      await app.screenshot("fleet-all-quiet");
      await fleet.tap();

      const migration = await second.thread({
        project: scripts,
        title: "Schema migration",
        messages: ["Run the schema migration"],
        model: "approval",
      });
      await expect(screen.getByRole("button", "Fleet: 1 needs you")).toBeVisible(LINKED_READ);
      await fleet.tap();
      await expect(needsYou.getByText("Waiting for your answer", { exact: true })).toBeVisible();
      await expect(
        needsYou.getByText("Asked: Run the schema migration", { exact: true }),
      ).toBeVisible();
      await panelSettled();
      await app.screenshot("fleet-linked-waiting");
      await needsYou.getByRole("button", "Schema migration", { exact: false }).tap();
      await expect(browser).toHaveURL(
        `${origin}/linked/${via}/${box}/${encodeURIComponent(migration.threadId)}`,
      );
      await expect(
        screen.getByText("Run the schema migration", { exact: true }).first(),
      ).toBeVisible({ timeout: 60_000 });
      await app.screenshot("fleet-linked-chat");
    } finally {
      await server.stop();
    }

    await t3.open();
    await fleet.tap();
    await expect(panel.getByText("This machine cannot be reached", { exact: false })).toBeVisible(
      LINKED_READ,
    );
    await panelSettled();
    await app.screenshot("fleet-machine-unreachable");
  },
);
