// @effect-diagnostics nodeBuiltinImport:off -- Intercepts the spawn that starts SISO's update command.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { autoUpdater, type UpdateCheckResult } from "electron-updater";
import type * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import { vi } from "vite-plus/test";

// electron-updater requires Electron natively, outside vi.mock's reach, and builds its
// autoUpdater singleton as soon as it is imported.
vi.hoisted(() => {
  const NodeModule = process.getBuiltinModule("node:module");
  const NodeEvents = process.getBuiltinModule("node:events");
  const require = NodeModule.createRequire(import.meta.url);
  const electronPath = NodeModule.createRequire(require.resolve("electron-updater")).resolve(
    "electron",
  );
  const electronModule = new NodeModule.Module(electronPath);
  electronModule.filename = electronPath;
  electronModule.loaded = true;
  electronModule.exports = {
    app: {
      getVersion: () => "1.0.0",
      getName: () => "T3 Code",
      isPackaged: true,
      quit: () => undefined,
      once: () => undefined,
    },
    autoUpdater: new NodeEvents.EventEmitter(),
  };
  require.cache[electronPath] = electronModule;
});

import * as ElectronUpdater from "./ElectronUpdater.ts";
import { SISO_UPDATE_COMMAND_ENV } from "./SisoUpdateHandoff.ts";

const offered = "0.1.99-nightly.20991231.1";
// Any executable stands in for t3-siso-update: the spawn below records it and runs `true`.
const sisoUpdateCommand = "/bin/sh";

const childProcess = NodeModule.createRequire(import.meta.url)("node:child_process") as {
  spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess;
};

// Records every command started, in the order started.
const recordSpawns = Effect.acquireRelease(
  Effect.sync(() => {
    const started: Array<string> = [];
    const realSpawn = childProcess.spawn;
    childProcess.spawn = (command, args, options) => {
      started.push([command, ...args].join(" "));
      return realSpawn("true", [], options);
    };
    NodeModule.syncBuiltinESMExports();
    vi.stubEnv(SISO_UPDATE_COMMAND_ENV, sisoUpdateCommand);
    return { started, realSpawn };
  }),
  ({ realSpawn }) =>
    Effect.sync(() => {
      childProcess.spawn = realSpawn;
      NodeModule.syncBuiltinESMExports();
      vi.unstubAllEnvs();
    }),
).pipe(Effect.map(({ started }) => started));

const offer = (isUpdateAvailable: boolean) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      vi.spyOn(autoUpdater, "checkForUpdates").mockResolvedValue({
        isUpdateAvailable,
        updateInfo: { version: offered },
      } as UpdateCheckResult),
    ),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("SISO build updates", () => {
  it.effect("an offered update starts SISO's rebuild of that version", () =>
    Effect.gen(function* () {
      const started = yield* recordSpawns;
      yield* offer(true);
      const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
      yield* electronUpdater.setAutoDownload(true);

      yield* electronUpdater.checkForUpdates;

      assert.deepStrictEqual(started, [`${sisoUpdateCommand} trigger --offered ${offered}`]);
      assert.isFalse(autoUpdater.autoDownload, "a check must never download the stock update");
    }).pipe(Effect.scoped, Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("no offer starts nothing", () =>
    Effect.gen(function* () {
      const started = yield* recordSpawns;
      yield* offer(false);
      const electronUpdater = yield* ElectronUpdater.ElectronUpdater;

      yield* electronUpdater.checkForUpdates;

      assert.deepStrictEqual(started, []);
    }).pipe(Effect.scoped, Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("downloading refuses the stock update and says SISO is rebuilding it", () =>
    Effect.gen(function* () {
      const started = yield* recordSpawns;
      yield* offer(true);
      const download = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(autoUpdater, "downloadUpdate")),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
      yield* electronUpdater.checkForUpdates;

      const exit = yield* Effect.exit(electronUpdater.downloadUpdate);

      assert.isTrue(Exit.isFailure(exit));
      const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined;
      assert.include(
        String(reason?._tag === "Fail" ? (reason.error.cause as Error).message : reason),
        `This T3 is a SISO build, so it does not download the stock update: SISO is rebuilding ${offered}`,
      );
      assert.strictEqual(download.mock.calls.length, 0);
      assert.lengthOf(started, 2, "the check and the download each start the rebuild");
    }).pipe(Effect.scoped, Effect.provide(ElectronUpdater.layer)),
  );
});
