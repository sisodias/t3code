// @effect-diagnostics nodeBuiltinImport:off -- Starts SISO's update command as its own process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

// This T3 is a SISO build: upstream T3 plus SISO's patches. Installing the stock update T3
// offers would silently drop those patches, so an offer starts SISO's update command instead.
// That command rebuilds the offered nightly with the patches and swaps it in when T3 is idle.

export const SISO_UPDATE_COMMAND_ENV = "T3CODE_SISO_UPDATE_COMMAND";

const sisoUpdateCommand = (env: NodeJS.ProcessEnv = process.env): string =>
  env[SISO_UPDATE_COMMAND_ENV] ??
  NodePath.join(env.HOME ?? NodeOS.homedir(), ".local", "bin", "t3-siso-update");

export class SisoBuildRefusesStockUpdate extends Schema.TaggedError<SisoBuildRefusesStockUpdate>()(
  "SisoBuildRefusesStockUpdate",
  { handOff: Schema.String },
) {
  override get message(): string {
    return `This T3 is a SISO build, so it does not download the stock update: ${this.handOff}.`;
  }
}

/**
 * Starts `<command> trigger --offered <version>` detached, so it outlives T3 restarting.
 * Returns why it could not start, or undefined once it has.
 */
export const handOffToSisoUpdate = (
  offeredVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const command = sisoUpdateCommand(env);
  try {
    NodeFS.accessSync(command, NodeFS.constants.X_OK);
    const child = NodeChildProcess.spawn(command, ["trigger", "--offered", offeredVersion], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.on("error", () => undefined);
    child.unref();
    return undefined;
  } catch (cause) {
    return `SISO's update command ${command} could not start: ${String(cause)}`;
  }
};

export const refuseStockUpdate = (
  offeredVersion: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SisoBuildRefusesStockUpdate => {
  const handOff =
    offeredVersion === undefined
      ? "no offered version is known yet"
      : (handOffToSisoUpdate(offeredVersion, env) ??
        `SISO is rebuilding ${offeredVersion} with its patches and switches to it when T3 is idle`);
  return new SisoBuildRefusesStockUpdate({ handOff });
};
