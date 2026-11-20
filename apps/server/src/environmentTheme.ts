// @effect-diagnostics nodeBuiltinImport:off - the guarded file read needs open
// flags (O_NOFOLLOW, O_NONBLOCK) the FileSystem service does not expose.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type DefaultAppearancePreference,
  EnvironmentTheme,
  type EnvironmentThemeBackgroundKind,
  type ServerSettingsError,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
  THEME_CSS_MAX_LENGTH,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { themeCssLoadsRemoteFiles } from "@t3tools/shared/themeCss";
import {
  MOBILE_DEFAULT_THEME_ID,
  MOBILE_THEME_IDS,
  UNPUBLISHABLE_THEME_IDS,
} from "@t3tools/shared/themePalettes";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as ServerSettings from "./serverSettings.ts";
import { watchDirectoryPath } from "./watchDirectoryReplacements.ts";

const decodeEnvironmentThemeFileJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(EnvironmentThemeFile),
);
const encodeEnvironmentThemeFileJson = Schema.encodeEffect(
  fromJsonStringPretty(EnvironmentThemeFile),
);
const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

const THEME_FILE_SUFFIX = ".json";

const MAX_THEME_FILES = 32;
/**
 * Shared with publishing so it cannot accept files the watcher skips. Fits the longest CSS in any
 * JSON encoding, at up to 6 bytes per character for a `\uXXXX` escape, plus the colors.
 */
export const MAX_THEME_FILE_BYTES = 6 * THEME_CSS_MAX_LENGTH + 16 * 1024;
// Clients cache every published theme in localStorage, which holds about 5 MB per origin.
const MAX_THEME_TOTAL_BYTES = 2 * 1024 * 1024;

/** A theme's background is `<id>.<extension>` beside `<id>.json`; earlier extensions win. */
const THEME_BACKGROUND_EXTENSIONS = {
  webm: "video",
  mp4: "video",
  webp: "image",
  png: "image",
  jpg: "image",
  jpeg: "image",
} as const satisfies Record<string, EnvironmentThemeBackgroundKind>;
const THEME_BACKGROUND_FORMATS = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "video/webm": "webm",
  "video/mp4": "mp4",
} as const;
type ThemeBackgroundMimeType = keyof typeof THEME_BACKGROUND_FORMATS;
export const MAX_THEME_BACKGROUND_BYTES = {
  image: 16 * 1024 * 1024,
  video: 64 * 1024 * 1024,
} as const satisfies Record<EnvironmentThemeBackgroundKind, number>;
const THEME_BACKGROUND_HEADER_BYTES = 64;
// ISO media brands browsers play as MP4. HEIC and AVIF images share the box format but not these.
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
]);
const THEME_BACKGROUND_FILES = "a JPEG, PNG, or WebP image, or a WebM or MP4 video";

interface PublishedThemes {
  readonly seq: number;
  readonly themes: ReadonlyArray<EnvironmentTheme>;
}

const INVALID_ID =
  "is not a valid theme id. Use lowercase letters, digits, and hyphens, and not a built-in name.";
const NOT_PUBLISHED = "could not be published. The themes directory may be full or not writable.";

/** A theme the service will not publish or select. `problem` ends the sentence naming it. */
export class EnvironmentThemeRefusedError extends Schema.TaggedError<EnvironmentThemeRefusedError>()(
  "EnvironmentThemeRefusedError",
  {
    themeId: Schema.String,
    problem: Schema.String,
    known: Schema.optional(Schema.Array(Schema.String)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const known = this.known ? ` Available: ${this.known.join(", ")}.` : "";
    return `Theme "${this.themeId}" ${this.problem}${known}`;
  }
}

/** The settings write that makes a theme or mode the default failed. */
export class EnvironmentThemeNotSelectedError extends Schema.TaggedError<EnvironmentThemeNotSelectedError>()(
  "EnvironmentThemeNotSelectedError",
  {
    /** Absent when only the appearance was set. */
    themeId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const subject = this.themeId === undefined ? "The appearance" : `Theme "${this.themeId}"`;
    return `${subject} was not applied, because the settings could not be saved.`;
  }
}

export class EnvironmentThemeService extends Context.Service<
  EnvironmentThemeService,
  {
    readonly current: Effect.Effect<ReadonlyArray<EnvironmentTheme>>;

    /** The default theme id and the published themes, plus the one named `themeId`. */
    readonly read: (themeId?: string) => Effect.Effect<
      {
        readonly current: string;
        /** Where theme files and their background images live. */
        readonly themesDir: string;
        readonly themes: ReadonlyArray<EnvironmentTheme>;
        readonly theme?: EnvironmentTheme;
      },
      EnvironmentThemeRefusedError | ServerSettingsError
    >;

    /**
     * Makes `themeId` the environment theme and `appearance` its mode, so connected clients
     * switch to them. With `theme`, first publishes that file under the id, replacing one already
     * there. With `background`, copies that image or video beside the theme as its background.
     */
    readonly apply: (
      input:
        | {
            readonly themeId: string;
            readonly theme?: EnvironmentThemeFile | undefined;
            /** Absolute path of the file to copy. */
            readonly background?: string | undefined;
            readonly appearance?: Exclude<DefaultAppearancePreference, ""> | undefined;
          }
        | { readonly appearance: Exclude<DefaultAppearancePreference, ""> },
    ) => Effect.Effect<void, EnvironmentThemeRefusedError | EnvironmentThemeNotSelectedError>;

    /** Subscribes before reading to retain changes during connection. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<EnvironmentTheme>>;
  }
>()("t3/environmentTheme/EnvironmentThemeService") {}

/** True when anything, a dangling symlink included, is at the path. */
const pathIsTaken = (filePath: string): boolean => {
  try {
    NodeFS.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
};

/** Rejects symlinked files, allows symlinked directories. Uses non-blocking opens against FIFOs;
 * Windows lacks these flags and checks symlinks with lstat. */
const openGuarded = (filePath: string): number | null => {
  try {
    if (NodeFS.constants.O_NOFOLLOW === undefined && NodeFS.lstatSync(filePath).isSymbolicLink()) {
      return null;
    }
    return NodeFS.openSync(
      filePath,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return null;
  }
};

/** Validates and reads one handle with the guards of `openGuarded`. */
export const readThemeFileGuarded = (filePath: string, maxBytes: number): string | null => {
  const fd = openGuarded(filePath);
  if (fd === null) return null;
  try {
    const info = NodeFS.fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const contents = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < contents.length) {
      const read = NodeFS.readSync(fd, contents, offset, contents.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    // Unlike Buffer#toString, TextDecoder drops a UTF-8 BOM, which JSON.parse rejects.
    return new TextDecoder().decode(contents.subarray(0, offset));
  } catch {
    return null;
  } finally {
    NodeFS.closeSync(fd);
  }
};

/** The format a background file's first bytes show, whatever its name says. */
export function sniffThemeBackground(header: Uint8Array): ThemeBackgroundMimeType | null {
  const bytes = Buffer.from(header.buffer, header.byteOffset, header.byteLength);
  const text = bytes.toString("latin1");
  if (text.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (text.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  // An EBML header whose DocType is webm, not another Matroska type.
  if (text.startsWith("\x1a\x45\xdf\xa3") && text.includes("webm")) return "video/webm";
  if (text.slice(4, 8) === "ftyp") {
    // The ftyp box: size, "ftyp", major brand, minor version, then compatible brands.
    const boxEnd = Math.min(bytes.length, bytes.readUInt32BE(0));
    const brands = [text.slice(8, 12)];
    for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
      brands.push(text.slice(offset, offset + 4));
    }
    if (brands.some((brand) => MP4_BRANDS.has(brand))) return "video/mp4";
  }
  return null;
}

const describeKind = (kind: EnvironmentThemeBackgroundKind) =>
  kind === "video" ? "a video" : "an image";

/** Checks a background's bytes and size per kind, through the guards of `openGuarded`. */
function inspectThemeBackground(filePath: string):
  | {
      readonly mimeType: ThemeBackgroundMimeType;
      readonly kind: EnvironmentThemeBackgroundKind;
      readonly info: NodeFS.BigIntStats;
    }
  | { readonly problem: string } {
  const fd = openGuarded(filePath);
  if (fd === null) return { problem: "could not be read, or is a symlink." };
  try {
    const info = NodeFS.fstatSync(fd, { bigint: true });
    if (!info.isFile()) return { problem: "is not a file." };
    const header = Buffer.alloc(THEME_BACKGROUND_HEADER_BYTES);
    const read = NodeFS.readSync(fd, header, 0, header.length, 0);
    const mimeType = sniffThemeBackground(header.subarray(0, read));
    if (mimeType === null) return { problem: `is not ${THEME_BACKGROUND_FILES}.` };
    const kind = mimeType.startsWith("video/") ? "video" : "image";
    const limit = MAX_THEME_BACKGROUND_BYTES[kind];
    if (info.size > BigInt(limit)) {
      return {
        problem: `is larger than ${limit / 1024 / 1024} MB, the limit for ${describeKind(kind)}.`,
      };
    }
    return { mimeType, kind, info };
  } catch {
    return { problem: "could not be read." };
  } finally {
    NodeFS.closeSync(fd);
  }
}

/**
 * The background published beside `themeId`, if any. Symlinks, oversized files, and files whose
 * bytes are not the kind their extension names are skipped, and reported to `onSkip`. `entries`
 * lets a directory scan skip lookups for names it did not list.
 */
export function findThemeBackground(
  themesDir: string,
  themeId: string,
  entries?: ReadonlySet<string>,
  onSkip?: (path: string, problem: string) => void,
): {
  readonly path: string;
  readonly revision: string;
  readonly kind: EnvironmentThemeBackgroundKind;
  readonly mimeType: ThemeBackgroundMimeType;
} | null {
  for (const [extension, kind] of Object.entries(THEME_BACKGROUND_EXTENSIONS)) {
    const name = `${themeId}.${extension}`;
    if (entries !== undefined && !entries.has(name)) continue;
    // Native separators: the asset route refuses a path that differs from its canonical form.
    const filePath = NodePath.join(themesDir, name);
    const file = inspectThemeBackground(filePath);
    if ("problem" in file || file.kind !== kind) {
      onSkip?.(
        filePath,
        "problem" in file
          ? file.problem
          : `holds ${describeKind(file.kind)}, but .${extension} is for ${describeKind(kind)}.`,
      );
      continue;
    }
    return {
      path: filePath,
      kind,
      mimeType: file.mimeType,
      revision: [file.info.ino, file.info.size, file.info.mtimeNs]
        .map((part) => part.toString(36))
        .join("-"),
    };
  }
  return null;
}

/** A file that cannot be a theme's background. `problem` ends the sentence naming the file. */
export class ThemeBackgroundRefusedError extends Schema.TaggedError<ThemeBackgroundRefusedError>()(
  "ThemeBackgroundRefusedError",
  {
    filePath: Schema.String,
    problem: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.filePath} ${this.problem}`;
  }
}

/**
 * Copies the image or video at `sourcePath` beside `themeId` as its only background, named for
 * what its bytes hold. Other backgrounds of the theme move aside: `commit` deletes them, and
 * `revert` removes the copy and puts them back.
 */
export const stageThemeBackground = Effect.fn("EnvironmentTheme.stageBackground")(
  function* (input: {
    readonly themesDir: string;
    readonly themeId: string;
    readonly sourcePath: string;
  }) {
    const refuse = (problem: string, cause?: unknown) =>
      new ThemeBackgroundRefusedError({
        filePath: input.sourcePath,
        problem,
        ...(cause === undefined ? {} : { cause }),
      });
    if (!NodePath.isAbsolute(input.sourcePath)) {
      return yield* refuse("is not an absolute path.");
    }
    const source = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.sourcePath),
      catch: (cause) => refuse("could not be read.", cause),
    });
    const file = inspectThemeBackground(source);
    if ("problem" in file) return yield* refuse(file.problem);

    const extension = THEME_BACKGROUND_FORMATS[file.mimeType];
    const destination = NodePath.join(input.themesDir, `${input.themeId}.${extension}`);
    // Neither name ends in a background extension, so readers never see them.
    const staging = `${destination}.staging-${process.pid}`;
    const moved: Array<readonly [from: string, to: string]> = [];
    let stagedIno: bigint | undefined;
    const revert = Effect.promise(async () => {
      await NodeFSP.rm(staging, { force: true }).catch(() => {});
      const current = await NodeFSP.lstat(destination, { bigint: true }).catch(() => null);
      if (current !== null && current.ino === stagedIno) {
        await NodeFSP.unlink(destination).catch(() => {});
      }
      for (const [from, to] of moved.toReversed()) await NodeFSP.rename(to, from).catch(() => {});
    });
    const commit = Effect.promise(() =>
      Promise.all(moved.map(([, to]) => NodeFSP.rm(to, { force: true }).catch(() => {}))),
    ).pipe(Effect.asVoid);

    const copy = (step: () => Promise<void>) =>
      Effect.tryPromise({
        try: step,
        catch: (cause) => refuse(`could not be copied into ${input.themesDir}.`, cause),
      }).pipe(Effect.tapError(() => revert));

    yield* copy(async () => {
      await NodeFSP.mkdir(input.themesDir, { recursive: true });
      await NodeFSP.rm(staging, { force: true });
      // Exclusive create: a link left at the staging path is never written through.
      await NodeFSP.copyFile(source, staging, NodeFS.constants.COPYFILE_EXCL);
      stagedIno = (await NodeFSP.lstat(staging, { bigint: true })).ino;
    });
    // The source can change after its check; the copy is what clients will be served.
    const copied = inspectThemeBackground(staging);
    if ("problem" in copied || copied.mimeType !== file.mimeType) {
      yield* revert;
      return yield* refuse("changed while it was being copied.");
    }
    yield* copy(async () => {
      for (const other of Object.keys(THEME_BACKGROUND_EXTENSIONS)) {
        const from = NodePath.join(input.themesDir, `${input.themeId}.${other}`);
        const info = await NodeFSP.lstat(from).catch(() => null);
        if (info === null || info.isDirectory()) continue;
        const to = `${from}.rollback-${NodeCrypto.randomUUID()}`;
        await NodeFSP.rename(from, to);
        moved.push([from, to]);
      }
      await NodeFSP.rename(staging, destination);
    });
    return { kind: file.kind, revert, commit };
  },
);

export const readPublishedThemes = Effect.fn(function* (themesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(themesDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  const themes: Array<EnvironmentTheme> = [];
  const entryNames = new Set(entries);
  let examined = 0;
  let totalBytes = 0;
  for (const entry of entries.toSorted()) {
    if (!entry.endsWith(THEME_FILE_SUFFIX)) continue;
    const id = entry.slice(0, -THEME_FILE_SUFFIX.length);
    // Reserved ids shadow built-ins or capture clients that never chose them.
    if (!isEnvironmentThemeId(id) || UNPUBLISHABLE_THEME_IDS.has(id)) continue;

    // Cap examined files, not accepted themes, to bound work on malformed directories.
    examined += 1;
    if (examined > MAX_THEME_FILES) {
      yield* Effect.logWarning("ignoring environment theme files past the limit", {
        path: themesDir,
        limit: MAX_THEME_FILES,
      });
      break;
    }

    const filePath = `${themesDir}/${entry}`;
    const raw = readThemeFileGuarded(filePath, MAX_THEME_FILE_BYTES);
    if (raw === null) {
      yield* Effect.logWarning("ignoring unusable environment theme file", {
        path: filePath,
        limit: MAX_THEME_FILE_BYTES,
      });
      continue;
    }
    if (raw.trim().length === 0) continue;

    const decoded = decodeEnvironmentThemeFileJsonExit(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("ignoring invalid environment theme", {
        path: filePath,
        detail: Cause.pretty(decoded.cause),
      });
      continue;
    }
    const file = decoded.value;
    if (!environmentThemeFileHasColors(file)) {
      yield* Effect.logWarning("ignoring environment theme without colors", { path: filePath });
      continue;
    }

    totalBytes += Buffer.byteLength(raw);
    if (totalBytes > MAX_THEME_TOTAL_BYTES) {
      yield* Effect.logWarning("ignoring environment themes past the total size limit", {
        path: themesDir,
        limit: MAX_THEME_TOTAL_BYTES,
      });
      break;
    }

    const skipped: Array<{ readonly path: string; readonly problem: string }> = [];
    const background = findThemeBackground(themesDir, id, entryNames, (path, problem) =>
      skipped.push({ path, problem }),
    );
    for (const skip of skipped) {
      yield* Effect.logWarning("ignoring unusable environment theme background", skip);
    }
    themes.push({
      id,
      ...file,
      ...(background ? { background: background.revision, backgroundKind: background.kind } : {}),
    });
  }
  return themes;
});

const make = Effect.gen(function* () {
  const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Sequence numbers let subscribers drop queued events older than their initial snapshot.
  const changes = yield* PubSub.sliding<PublishedThemes>(1);
  const published = yield* Ref.make<PublishedThemes>({ seq: 0, themes: [] });
  // Serialize read/compare/publish so slow older reads cannot publish with newer sequence numbers.
  const refreshSemaphore = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const refresh = refreshSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const themes = yield* readPublishedThemes(environmentThemesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      // Compare the whole value so new fields cannot silently miss republishes.
      const [changed, next] = yield* Ref.modify(
        published,
        (previous): readonly [readonly [boolean, PublishedThemes], PublishedThemes] => {
          if (Equal.equals(previous.themes, themes)) return [[false, previous], previous];
          const updated: PublishedThemes = { seq: previous.seq + 1, themes };
          return [[true, updated], updated];
        },
      );
      if (changed) yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
      return next;
    }),
  );

  yield* fs
    .makeDirectory(environmentThemesDir, { recursive: true })
    .pipe(Effect.ignoreCause({ log: true }));

  const watchDirectory = (directory: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const markReady = () => Deferred.doneUnsafe(ready, Exit.void);
        const events = fs.watch(directory, { onReady: markReady }).pipe(
          Stream.as(undefined),
          Stream.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Stream.empty,
          ),
          Stream.ignoreCause({ log: true }),
          Stream.ensuring(Effect.sync(markReady)),
        );
        return Stream.merge(events, Stream.fromEffect(Deferred.await(ready)));
      }),
    );

  const watchEvents = watchDirectoryPath(
    environmentThemesDir,
    watchDirectory(environmentThemesDir),
  ).pipe(
    // A save emits several events, and fs.watch can fire before content is flushed.
    Stream.debounce(Duration.millis(100)),
  );

  yield* refresh;
  yield* Stream.runForEach(watchEvents, () => refresh.pipe(Effect.ignoreCause({ log: true }))).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(watcherScope),
    Effect.asVoid,
  );

  // One publish at a time: they share a staging path, and each one checks what is served after it.
  const publishSemaphore = yield* Semaphore.make(1);

  /** Callers hold `publishSemaphore`. Succeeds with the effect that undoes this publish. */

  const publish = Effect.fnUntraced(function* (themeId: string, file: EnvironmentThemeFile) {
    if (UNPUBLISHABLE_THEME_IDS.has(themeId)) {
      return yield* new EnvironmentThemeRefusedError({ themeId, problem: INVALID_ID });
    }
    if (!environmentThemeFileHasColors(file)) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: "has no colors. Give canvas and accent, or at least one color role.",
      });
    }
    if (file.css !== undefined && themeCssLoadsRemoteFiles(file.css)) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem:
          "has CSS that loads files. Remove @import, image-set(), and url() that is not data: or #id.",
      });
    }
    const contents = yield* encodeEnvironmentThemeFileJson(file).pipe(
      Effect.mapError(
        (cause) => new EnvironmentThemeRefusedError({ themeId, problem: NOT_PUBLISHED, cause }),
      ),
    );
    if (Buffer.byteLength(contents) > MAX_THEME_FILE_BYTES) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: `is larger than ${MAX_THEME_FILE_BYTES} bytes.`,
      });
    }

    const destination = `${environmentThemesDir}/${themeId}${THEME_FILE_SUFFIX}`;
    // The watcher reads only .json names, so it never sees a half-written file.
    const staging = `${destination}.staging-${process.pid}`;
    // Exclusive create: a link left at the staging path is removed, never written through.
    const replace = (next: string) =>
      fs.remove(staging, { force: true }).pipe(
        Effect.andThen(fs.writeFileString(staging, next, { flag: "wx" })),
        Effect.andThen(fs.rename(staging, destination)),
        Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)),
      );

    // The guarded reader does not block on a FIFO and does not follow a symlink.
    const previous = Option.fromNullOr(readThemeFileGuarded(destination, MAX_THEME_FILE_BYTES));
    // A file it cannot read back, such as one over the size limit, could not be restored.
    if (Option.isNone(previous) && pathIsTaken(destination)) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: "would replace a file that could not be backed up. Use another theme id.",
      });
    }
    const servedBefore = (yield* refresh).themes.map((theme) => theme.id);
    // Puts back what was there, so a failed apply does not take a working theme away.
    const revert = Option.match(previous, {
      onNone: () => fs.remove(destination, { force: true }),
      onSome: replace,
    }).pipe(Effect.ignore, Effect.andThen(refresh), Effect.asVoid);

    yield* fs.makeDirectory(environmentThemesDir, { recursive: true }).pipe(
      Effect.andThen(replace(contents)),
      Effect.mapError(
        (cause) => new EnvironmentThemeRefusedError({ themeId, problem: NOT_PUBLISHED, cause }),
      ),
    );
    // The reader stops at its count and size limits, so this file can go unserved, or it can
    // push another theme out. Both count as a failed publish.
    const served = new Set((yield* refresh).themes.map((theme) => theme.id));
    if (served.has(themeId) && servedBefore.every((id) => served.has(id))) return revert;
    yield* revert;
    return yield* new EnvironmentThemeRefusedError({ themeId, problem: NOT_PUBLISHED });
  });

  const apply: EnvironmentThemeService["Service"]["apply"] = Effect.fn(
    "EnvironmentThemeService.apply",
  )(function* (input) {
    const themeId = "themeId" in input ? input.themeId : undefined;
    const theme = "theme" in input ? input.theme : undefined;
    const background = "background" in input ? input.background : undefined;
    const { appearance } = input;
    if (themeId !== undefined && !isEnvironmentThemeId(themeId)) {
      return yield* new EnvironmentThemeRefusedError({ themeId, problem: INVALID_ID });
    }
    // Timestamps make clients apply a set again when its value did not change. Theme and
    // appearance have one each, so setting one does not undo a later local choice of the other.
    // The stock theme is an empty default with a set time, which clients adopt as stock.
    const defaultTheme = themeId === MOBILE_DEFAULT_THEME_ID ? "" : themeId;
    const select = Effect.gen(function* () {
      const setAt = DateTime.formatIso(yield* DateTime.now);
      yield* settings
        .updateSettings({
          ...(defaultTheme === undefined ? {} : { defaultTheme, defaultThemeSetAt: setAt }),
          ...(appearance === undefined
            ? {}
            : { defaultAppearance: appearance, defaultAppearanceSetAt: setAt }),
        })
        .pipe(Effect.mapError((cause) => new EnvironmentThemeNotSelectedError({ themeId, cause })));
    });
    // One at a time, so a selection never sees a file that a failed publish then takes back.
    // If the theme cannot be selected, the files it replaced come back.
    yield* publishSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (themeId === undefined) return yield* select;
        let revert: Effect.Effect<void> = Effect.void;
        if (theme === undefined) {
          const published = (yield* refresh).themes.map(({ id }) => id);
          const known = [...MOBILE_THEME_IDS, ...published];
          if (!known.includes(themeId)) {
            return yield* new EnvironmentThemeRefusedError({
              themeId,
              problem: "is not a built-in or published theme.",
              known,
            });
          }
          if (background !== undefined && !published.includes(themeId)) {
            return yield* new EnvironmentThemeRefusedError({
              themeId,
              problem: "is built in and cannot have a background. Publish a theme to give it one.",
            });
          }
        } else {
          revert = yield* publish(themeId, theme);
        }
        if (background === undefined) return yield* select.pipe(Effect.tapError(() => revert));

        const staged = yield* stageThemeBackground({
          themesDir: environmentThemesDir,
          themeId,
          sourcePath: background,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentThemeRefusedError({
                themeId,
                problem: `cannot use the background ${cause.filePath}, which ${cause.problem}`,
                cause,
              }),
          ),
          Effect.tapError(() => revert),
        );
        yield* select.pipe(Effect.tapError(() => staged.revert.pipe(Effect.andThen(revert))));
        yield* staged.commit;
        yield* refresh;
      }),
    );
  });

  const read: EnvironmentThemeService["Service"]["read"] = Effect.fn(
    "EnvironmentThemeService.read",
  )(function* (themeId) {
    const { themes } = yield* refresh;
    const { defaultTheme } = yield* settings.getSettings;
    const themesDir = environmentThemesDir;
    if (themeId === undefined) return { current: defaultTheme, themesDir, themes };
    const theme = themes.find((candidate) => candidate.id === themeId);
    if (theme === undefined) {
      return yield* new EnvironmentThemeRefusedError({
        themeId,
        problem: "is not a published theme.",
        known: themes.map(({ id }) => id),
      });
    }
    return { current: defaultTheme, themesDir, themes, theme };
  });

  return {
    current: Effect.map(refresh, (state) => state.themes),
    read,
    apply,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* refresh;
          return Stream.concat(
            Stream.make(snapshot.themes),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.seq > snapshot.seq),
              Stream.map((update) => update.themes),
            ),
          );
        }),
      );
    },
  } satisfies EnvironmentThemeService["Service"];
});

export const layer = Layer.effect(EnvironmentThemeService, make);
