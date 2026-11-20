import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentThemeFile,
  ServerSettingsError,
  THEME_CSS_MAX_LENGTH,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const encodeThemeFile = Schema.encodeSync(Schema.fromJsonString(EnvironmentThemeFile));
/** Writes non-ASCII characters as `\uXXXX` escapes, as encoders such as Python's json.dumps do. */
const encodeThemeFileEscaped = (theme: EnvironmentThemeFile) =>
  encodeThemeFile(theme).replace(
    /[\u0080-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const latin1 = (text: string) => Buffer.from(text, "latin1");
/** An ftyp box: size, "ftyp", major brand, minor version, then compatible brands. */
const ftyp = (major: string, ...compatible: ReadonlyArray<string>) => {
  const box = latin1(`\0\0\0\0ftyp${major}\0\0\x02\0${compatible.join("")}`);
  box.writeUInt32BE(box.length, 0);
  return box;
};
/** An EBML header as ffmpeg writes it: versions and lengths, then DocType and its versions. */
const ebml = (docType: string, docTypeVersion: number) =>
  Buffer.concat([
    Buffer.from("1a45dfa3", "hex"),
    Buffer.from([0x80 | (27 + docType.length)]),
    Buffer.from("4286810142f7810142f2810442f381084282", "hex"),
    Buffer.from([0x80 | docType.length]),
    latin1(docType),
    Buffer.from([0x42, 0x87, 0x81, docTypeVersion, 0x42, 0x85, 0x81, 0x02]),
  ]);
/** The first bytes of each format; the rest of a file is zeros. */
const HEADERS = {
  png: latin1("\x89PNG\r\n\x1a\n\0\0\0\rIHDR"),
  jpeg: latin1("\xff\xd8\xff\xe0\0\x10JFIF\0"),
  webp: latin1("RIFF$\0\0\0WEBPVP8 "),
  webm: ebml("webm", 2),
  mp4: ftyp("isom", "isom", "iso2", "avc1", "mp41"),
  mkv: ebml("matroska", 4),
  // Not every browser shows HEIC, though its box is the one MP4 uses.
  heic: ftyp("heic", "mif1", "heic"),
};
const media = (header: Uint8Array, size = 256) => {
  const bytes = new Uint8Array(size);
  bytes.set(header);
  return bytes;
};

const NIGHTFALL_THEME: EnvironmentThemeFile = {
  name: "Nightfall",
  appearance: "dark",
  canvas: "#1a1b26",
  accent: "#7aa2f7",
};

const SHARED_THEME: EnvironmentThemeFile = {
  version: 1,
  name: "Shared Light",
  appearance: "light",
  colors: { canvas: "#eff1f5", accent: "#1e66f5" },
};

/** The settings mock refuses to make this theme the default, as a managed policy can. */
const REFUSED_THEME_ID = "refused";

const withEnvironmentThemes = <A, E>(
  seeds: Readonly<Record<string, string | Uint8Array>>,
  body: Effect.Effect<
    A,
    E,
    | EnvironmentTheme.EnvironmentThemeService
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
  /** Receives each theme and appearance the service makes the environment default. */
  selected: Array<{ readonly theme?: string; readonly appearance?: string }> = [],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-environment-theme-" });
    const themesDir = path.join(baseDir, "userdata", "themes");
    yield* fs.makeDirectory(themesDir, { recursive: true });
    for (const [filename, contents] of Object.entries(seeds)) {
      const filePath = path.join(themesDir, filename);
      yield* typeof contents === "string"
        ? fs.writeFileString(filePath, contents)
        : fs.writeFile(filePath, contents);
    }

    return yield* body.pipe(
      Effect.provide(
        EnvironmentTheme.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            Layer.mock(ServerSettingsService)({
              updateSettings: (patch) =>
                patch.defaultTheme === REFUSED_THEME_ID
                  ? Effect.fail(
                      new ServerSettingsError({
                        settingsPath: "settings.json",
                        operation: "write-managed-setting",
                      }),
                    )
                  : Effect.sync(() => {
                      selected.push({
                        ...(patch.defaultTheme === undefined ? {} : { theme: patch.defaultTheme }),
                        ...(patch.defaultAppearance === undefined
                          ? {}
                          : { appearance: patch.defaultAppearance }),
                      });
                      return DEFAULT_SERVER_SETTINGS;
                    }),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const currentThemes = Effect.gen(function* () {
  const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
  return yield* environmentTheme.current;
});

describe("environment theme", () => {
  it.effect("follows the directory rather than the set read at start", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fs.writeFileString(
          path.join(environmentThemesDir, "shared-light.json"),
          encodeThemeFile(SHARED_THEME),
        );
        assert.equal((yield* currentThemes).length, 2);

        yield* fs.remove(path.join(environmentThemesDir, "nightfall.json"));
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["shared-light"],
        );
      }),
    ),
  );

  it.effect("never replays a set older than the snapshot it started from", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* fs.writeFileString(
          path.join(environmentThemesDir, "shared-light.json"),
          encodeThemeFile(SHARED_THEME),
        );
        const seen = yield* Queue.unbounded<ReadonlyArray<{ readonly id: string }>>();
        yield* Stream.runForEach(environmentTheme.streamChanges, (themes) =>
          Queue.offer(seen, themes),
        ).pipe(Effect.forkScoped);
        assert.deepEqual(
          (yield* Queue.take(seen)).map((theme) => theme.id),
          ["nightfall", "shared-light"],
        );
        yield* fs.remove(path.join(environmentThemesDir, "nightfall.json"));
        yield* currentThemes;
        assert.deepEqual(
          (yield* Queue.take(seen)).map((theme) => theme.id),
          ["shared-light"],
        );
      }),
    ),
  );

  it.live("publishes restored themes to subscribers that saw the directory disappear", () =>
    withEnvironmentThemes(
      { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const service = yield* EnvironmentTheme.EnvironmentThemeService;
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const restored = path.join(path.dirname(environmentThemesDir), "themes-restored");
        yield* fs.makeDirectory(restored);
        yield* fs.writeFileString(
          path.join(restored, "shared-light.json"),
          encodeThemeFile(SHARED_THEME),
        );

        const snapshots = yield* service.streamChanges.pipe(
          Stream.map((themes) => themes.map((theme) => theme.name)),
          Stream.toQueue({ capacity: "unbounded" }),
        );
        assert.deepEqual(yield* Queue.take(snapshots), ["Nightfall"]);

        yield* fs.rename(
          environmentThemesDir,
          path.join(path.dirname(restored), "themes-previous"),
        );
        assert.deepEqual(yield* Queue.take(snapshots), []);

        yield* fs.rename(restored, environmentThemesDir);
        assert.deepEqual(yield* Queue.take(snapshots), ["Shared Light"]);

        yield* fs.writeFileString(
          path.join(environmentThemesDir, "nightfall.json"),
          encodeThemeFile(NIGHTFALL_THEME),
        );
        assert.deepEqual(yield* Queue.take(snapshots), ["Nightfall", "Shared Light"]);
      }),
    ),
  );

  it.live.skipIf(!symlinksSupported)(
    "publishes edits after the target of a symlinked themes directory is restored",
    () =>
      withEnvironmentThemes(
        { "nightfall.json": encodeThemeFile(NIGHTFALL_THEME) },
        Effect.gen(function* () {
          const service = yield* EnvironmentTheme.EnvironmentThemeService;
          const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-linked-themes-" });
          const targetParent = path.join(outside, "active-parent");
          const target = path.join(targetParent, "active");
          const restored = path.join(outside, "restored");
          yield* fs.makeDirectory(target, { recursive: true });
          yield* fs.makeDirectory(restored);
          let linkTarget = target;
          if ((yield* HostProcess.Platform) !== "win32") {
            const userdata = path.dirname(environmentThemesDir);
            const anchor = path.join(targetParent, "anchor");
            yield* fs.makeDirectory(anchor);
            yield* fs.makeDirectory(path.join(userdata, "active"));
            yield* fs.symlink(anchor, path.join(userdata, "alias"));
            linkTarget = "alias/../active";
          }
          yield* fs.writeFileString(
            path.join(target, "shared-light.json"),
            encodeThemeFile(SHARED_THEME),
          );
          yield* fs.writeFileString(
            path.join(restored, "nightfall.json"),
            encodeThemeFile(NIGHTFALL_THEME),
          );

          const snapshots = yield* service.streamChanges.pipe(
            Stream.map((themes) => themes.map((theme) => theme.name)),
            Stream.toQueue({ capacity: "unbounded" }),
          );
          assert.deepEqual(yield* Queue.take(snapshots), ["Nightfall"]);

          yield* fs.rename(environmentThemesDir, path.join(outside, "original"));
          yield* fs.symlink(linkTarget, environmentThemesDir);
          assert.deepEqual(
            yield* Stream.fromQueue(snapshots).pipe(
              Stream.filter((names) => names.length > 0),
              Stream.runHead,
              Effect.map((names) => names.valueOrUndefined),
            ),
            ["Shared Light"],
          );

          yield* fs.writeFileString(
            path.join(target, "nightfall.json"),
            encodeThemeFile(NIGHTFALL_THEME),
          );
          assert.deepEqual(yield* Queue.take(snapshots), ["Nightfall", "Shared Light"]);

          yield* fs.rename(target, path.join(outside, "previous"));
          assert.deepEqual(yield* Queue.take(snapshots), []);
          yield* fs.rename(restored, target);
          assert.deepEqual(yield* Queue.take(snapshots), ["Nightfall"]);

          yield* fs.writeFileString(
            path.join(target, "shared-light.json"),
            encodeThemeFile(SHARED_THEME),
          );
          assert.deepEqual(yield* Queue.take(snapshots), ["Nightfall", "Shared Light"]);

          const restoredParent = path.join(outside, "restored-parent");
          const restoredTarget = path.join(restoredParent, "active");
          yield* fs.makeDirectory(restoredTarget, { recursive: true });
          yield* fs.makeDirectory(path.join(restoredParent, "anchor"));
          yield* fs.writeFileString(
            path.join(restoredTarget, "shared-light.json"),
            encodeThemeFile(SHARED_THEME),
          );

          yield* fs.rename(targetParent, path.join(outside, "previous-parent"));
          assert.deepEqual(yield* Queue.take(snapshots), []);
          yield* fs.rename(restoredParent, targetParent);
          assert.deepEqual(yield* Queue.take(snapshots), ["Shared Light"]);

          yield* fs.writeFileString(
            path.join(target, "nightfall.json"),
            encodeThemeFile(NIGHTFALL_THEME),
          );
          assert.deepEqual(yield* Queue.take(snapshots), ["Nightfall", "Shared Light"]);
        }),
      ),
  );

  it.effect("skips invalid files while keeping valid ones", () =>
    withEnvironmentThemes(
      {
        "nightfall.json": encodeThemeFile(NIGHTFALL_THEME),
        "notepad.json": `\uFEFF${encodeThemeFile(SHARED_THEME)}`,
        "unresolved.json":
          '{ "name": "X", "appearance": "dark", "canvas": "{{ background }}", "accent": "#7aa2f7" }',
        "malformed.json": "{ not json",
        "no-colors.json": '{ "name": "Empty", "appearance": "dark" }',
        "Bad Name.json": encodeThemeFile(SHARED_THEME),
        "ocean.json": encodeThemeFile(SHARED_THEME),
        "dark.json": encodeThemeFile(SHARED_THEME),
        "notes.txt": "not a theme",
      },
      Effect.gen(function* () {
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["nightfall", "notepad"],
        );
      }),
    ),
  );

  it.effect("puts the previous theme back when the new one cannot be selected", () =>
    withEnvironmentThemes(
      { [`${REFUSED_THEME_ID}.json`]: encodeThemeFile(NIGHTFALL_THEME) },
      Effect.gen(function* () {
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const refused = yield* themes
          .apply({ themeId: REFUSED_THEME_ID, theme: { ...NIGHTFALL_THEME, name: "Changed" } })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "EnvironmentThemeNotSelectedError");
        assert.deepEqual(yield* themes.current, [{ id: REFUSED_THEME_ID, ...NIGHTFALL_THEME }]);
      }),
    ),
  );

  it.effect("does not replace a theme file it could not put back", () => {
    const oversized = JSON.stringify({
      ...NIGHTFALL_THEME,
      padding: "x".repeat(EnvironmentTheme.MAX_THEME_FILE_BYTES),
    });
    return withEnvironmentThemes(
      { [`${REFUSED_THEME_ID}.json`]: oversized },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig.ServerConfig;
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const refused = yield* themes
          .apply({ themeId: REFUSED_THEME_ID, theme: NIGHTFALL_THEME })
          .pipe(Effect.flip);
        assert.match(refused.message, /could not be backed up/);
        assert.strictEqual(
          yield* fs.readFileString(`${config.environmentThemesDir}/${REFUSED_THEME_ID}.json`),
          oversized,
        );
      }),
    );
  });

  it.effect.skipIf(!symlinksSupported)("does not write through a symlink at its staging path", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const outside = path.join(environmentThemesDir, "..", "outside.txt");
        yield* fs.writeFileString(outside, "keep");
        yield* fs.symlink(
          outside,
          path.join(environmentThemesDir, `look.json.staging-${process.pid}`),
        );

        yield* themes.apply({ themeId: "look", theme: NIGHTFALL_THEME });
        assert.strictEqual(yield* fs.readFileString(outside), "keep");
        assert.deepEqual(yield* themes.current, [{ id: "look", ...NIGHTFALL_THEME }]);
      }),
    ),
  );

  it.effect.skipIf(!symlinksSupported)("ignores a symlinked theme file", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = path.join(environmentThemesDir, "..", "outside.json");
        yield* fs.writeFileString(outside, encodeThemeFile(NIGHTFALL_THEME));
        yield* fs.symlink(outside, path.join(environmentThemesDir, "nightfall.json"));
        assert.deepEqual(yield* currentThemes, []);
      }),
    ),
  );

  it.effect("publishes and selects a theme, and refuses unsafe CSS and unknown ids", () => {
    const selected: Array<{ readonly theme?: string; readonly appearance?: string }> = [];
    return withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        // A comment may name an address. Only a rule that loads one is refused.
        const css =
          "/* from url(https://example.com/guide) */ [data-chat-header] { border-bottom: 1px solid red; }";
        yield* themes.apply({ themeId: "agent-look", theme: { ...NIGHTFALL_THEME, css } });
        assert.deepEqual(yield* themes.current, [{ id: "agent-look", ...NIGHTFALL_THEME, css }]);

        const leaky = yield* themes
          .apply({
            themeId: "leaky",
            theme: {
              ...NIGHTFALL_THEME,
              css: 'input[value^="a"] { background: url(https://example.com/a); }',
            },
          })
          .pipe(Effect.flip);
        assert.match(leaky.message, /loads files/);
        const reserved = yield* themes
          .apply({ themeId: "dark", theme: NIGHTFALL_THEME })
          .pipe(Effect.flip);
        assert.match(reserved.message, /not a valid theme id/);
        const unknown = yield* themes.apply({ themeId: "missing" }).pipe(Effect.flip);
        assert.match(unknown.message, /not a built-in or published theme/);
        yield* themes.apply({ themeId: "grove" });
        yield* themes.apply({ themeId: "grove", appearance: "dark" });
        yield* themes.apply({ appearance: "light" });

        assert.deepEqual(
          (yield* themes.current).map((theme) => theme.id),
          ["agent-look"],
        );
        // Only a theme that was published or already exists becomes the environment theme.
        assert.deepEqual(selected, [
          { theme: "agent-look" },
          { theme: "grove" },
          { theme: "grove", appearance: "dark" },
          { appearance: "light" },
        ]);
      }),
      selected,
    );
  });

  it.effect("switches back to the stock theme after selecting another", () => {
    const selected: Array<{ readonly theme?: string; readonly appearance?: string }> = [];
    return withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        yield* themes.apply({ themeId: "agent-look", theme: NIGHTFALL_THEME });
        yield* themes.apply({ themeId: "t3-code" });
        assert.deepEqual(selected, [{ theme: "agent-look" }, { theme: "" }]);
      }),
      selected,
    );
  });

  it("recognises a background by its bytes, whatever its name", () => {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(HEADERS).map(([format, header]) => [
          format,
          EnvironmentTheme.sniffThemeBackground(media(header)),
        ]),
      ),
      {
        png: "image/png",
        jpeg: "image/jpeg",
        webp: "image/webp",
        webm: "video/webm",
        mp4: "video/mp4",
        mkv: null,
        heic: null,
      },
    );
    assert.isNull(EnvironmentTheme.sniffThemeBackground(latin1("<svg onload=alert(1)>")));
    assert.isNull(EnvironmentTheme.sniffThemeBackground(new Uint8Array()));
  });

  it.effect(
    "reports the image or video beside a theme as its background, with a new revision per file",
    () =>
      withEnvironmentThemes(
        { "look.json": encodeThemeFile(NIGHTFALL_THEME), "look.png": media(HEADERS.png) },
        Effect.gen(function* () {
          const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const background = Effect.map(currentThemes, ([theme]) => ({
            revision: theme?.background,
            kind: theme?.backgroundKind,
          }));
          const image = path.join(environmentThemesDir, "look.png");
          const video = path.join(environmentThemesDir, "look.webm");

          const first = yield* background;
          assert.isDefined(first.revision);
          assert.strictEqual(first.kind, "image");
          yield* fs.writeFile(image, media(HEADERS.png, 512));
          assert.notStrictEqual((yield* background).revision, first.revision);

          yield* fs.writeFile(video, media(HEADERS.webm));
          assert.strictEqual((yield* background).kind, "video");
          yield* fs.remove(video);

          yield* fs.remove(image);
          assert.deepEqual(yield* background, { revision: undefined, kind: undefined });
          if (symlinksSupported) {
            const outside = path.join(environmentThemesDir, "..", "outside.png");
            yield* fs.writeFile(outside, media(HEADERS.png));
            yield* fs.symlink(outside, image);
            assert.deepEqual(yield* background, { revision: undefined, kind: undefined });
          }
        }),
      ),
  );

  it.effect("skips a background whose bytes or size do not fit what its name says", () =>
    withEnvironmentThemes(
      {
        "look.json": encodeThemeFile(NIGHTFALL_THEME),
        "look.webm": media(HEADERS.png),
        "look.mp4": media(HEADERS.mkv),
        "look.png": "<svg onload=alert(1)>",
        "look.jpg": media(HEADERS.jpeg),
      },
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const kind = Effect.map(currentThemes, ([theme]) => theme?.backgroundKind);
        // Sparse, so the large sizes take no disk.
        const resize = (name: string, size: number) =>
          fs.truncate(path.join(environmentThemesDir, name), size);
        const { image: imageLimit, video: videoLimit } =
          EnvironmentTheme.MAX_THEME_BACKGROUND_BYTES;

        assert.strictEqual(yield* kind, "image");
        yield* resize("look.jpg", imageLimit + 1);
        assert.isUndefined(yield* kind);

        yield* fs.writeFile(path.join(environmentThemesDir, "look.mp4"), media(HEADERS.mp4));
        yield* resize("look.mp4", imageLimit + 1);
        assert.strictEqual(yield* kind, "video");
        yield* resize("look.mp4", videoLimit + 1);
        assert.isUndefined(yield* kind);
        yield* resize("look.mp4", videoLimit);
        assert.strictEqual(yield* kind, "video");
      }),
    ),
  );

  it.effect("copies an image or video beside a theme as its only background", () =>
    withEnvironmentThemes(
      {},
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const sources = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-theme-sources-" });
        const clip = media(HEADERS.webm, 4096);
        const video = path.join(sources, "clip.bin");
        yield* fs.writeFile(video, clip);

        // The copy is named for what its bytes hold, not for the source's name.
        yield* themes.apply({ themeId: "look", theme: NIGHTFALL_THEME, background: video });
        const [published] = yield* themes.current;
        assert.strictEqual(published?.backgroundKind, "video");
        assert.isDefined(published?.background);
        assert.deepEqual(
          new Uint8Array(yield* fs.readFile(path.join(environmentThemesDir, "look.webm"))),
          clip,
        );

        // A published theme takes a new background without its file, which replaces the last.
        const image = path.join(sources, "photo.jpeg");
        yield* fs.writeFile(image, media(HEADERS.jpeg));
        yield* themes.apply({ themeId: "look", background: image });
        assert.strictEqual((yield* themes.current)[0]?.backgroundKind, "image");
        assert.deepEqual((yield* fs.readDirectory(environmentThemesDir)).toSorted(), [
          "look.jpg",
          "look.json",
        ]);
      }),
    ),
  );

  it.effect("refuses a background that is not a usable image or video, and keeps the last", () =>
    withEnvironmentThemes(
      { "look.json": encodeThemeFile(NIGHTFALL_THEME), "look.png": media(HEADERS.png) },
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const sources = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-theme-sources-" });
        const source = (name: string, bytes: Uint8Array, size?: number) =>
          Effect.gen(function* () {
            const filePath = path.join(sources, name);
            yield* fs.writeFile(filePath, bytes);
            if (size !== undefined) yield* fs.truncate(filePath, size);
            return filePath;
          });
        const refusal = (input: Parameters<typeof themes.apply>[0]) =>
          themes.apply(input).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        const { image: imageLimit, video: videoLimit } =
          EnvironmentTheme.MAX_THEME_BACKGROUND_BYTES;

        const notes = yield* source("notes.webm", latin1("only text"));
        assert.match(
          yield* refusal({ themeId: "look", background: notes }),
          /notes\.webm, which is not a JPEG, PNG, or WebP image, or a WebM or MP4 video\.$/,
        );
        const matroska = yield* source("clip.mkv", media(HEADERS.mkv));
        assert.match(yield* refusal({ themeId: "look", background: matroska }), /is not a JPEG/);
        const longVideo = yield* source("long.mp4", media(HEADERS.mp4), videoLimit + 1);
        assert.match(
          yield* refusal({ themeId: "look", background: longVideo }),
          /is larger than 64 MB, the limit for a video\.$/,
        );
        const largeImage = yield* source("large.png", media(HEADERS.png), imageLimit + 1);
        assert.match(
          yield* refusal({ themeId: "look", background: largeImage }),
          /is larger than 16 MB, the limit for an image\.$/,
        );
        assert.match(
          yield* refusal({ themeId: "look", background: "clip.webm" }),
          /is not an absolute path\.$/,
        );
        assert.match(
          yield* refusal({ themeId: "look", background: path.join(sources, "missing.webm") }),
          /could not be read\.$/,
        );
        const clip = yield* source("clip.webm", media(HEADERS.webm));
        assert.match(
          yield* refusal({ themeId: "grove", background: clip }),
          /is built in and cannot have a background/,
        );
        // A theme published with a refused background is taken back.
        assert.match(
          yield* refusal({ themeId: "fresh", theme: SHARED_THEME, background: notes }),
          /is not a JPEG/,
        );

        assert.deepEqual(
          (yield* themes.current).map((theme) => [theme.id, theme.backgroundKind]),
          [["look", "image"]],
        );
        assert.deepEqual((yield* fs.readDirectory(environmentThemesDir)).toSorted(), [
          "look.json",
          "look.png",
        ]);
      }),
    ),
  );

  it.effect("puts the previous background back when the theme cannot be selected", () =>
    withEnvironmentThemes(
      {
        [`${REFUSED_THEME_ID}.json`]: encodeThemeFile(NIGHTFALL_THEME),
        [`${REFUSED_THEME_ID}.png`]: media(HEADERS.png),
      },
      Effect.gen(function* () {
        const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const sources = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-theme-sources-" });
        const video = path.join(sources, "clip.webm");
        yield* fs.writeFile(video, media(HEADERS.webm));

        const refused = yield* themes
          .apply({
            themeId: REFUSED_THEME_ID,
            theme: { ...NIGHTFALL_THEME, name: "Changed" },
            background: video,
          })
          .pipe(Effect.flip);
        assert.strictEqual(refused._tag, "EnvironmentThemeNotSelectedError");
        const [restored] = yield* themes.current;
        assert.deepEqual([restored?.name, restored?.backgroundKind], ["Nightfall", "image"]);
        assert.deepEqual((yield* fs.readDirectory(environmentThemesDir)).toSorted(), [
          `${REFUSED_THEME_ID}.json`,
          `${REFUSED_THEME_ID}.png`,
        ]);
      }),
    ),
  );

  it.effect("keeps the served theme when an update does not fit the size limit", () => {
    const large = (name: string): EnvironmentThemeFile => ({
      ...NIGHTFALL_THEME,
      name,
      css: `/* ${"界".repeat(THEME_CSS_MAX_LENGTH - 6)} */`,
    });
    return withEnvironmentThemes(
      {
        ...Object.fromEntries(
          Array.from({ length: 3 }, (_, index) => [
            `aa-${index}.json`,
            encodeThemeFileEscaped(large(`Large ${index}`)),
          ]),
        ),
        "zz-look.json": encodeThemeFile(NIGHTFALL_THEME),
      },
      Effect.gen(function* () {
        const themes = yield* EnvironmentTheme.EnvironmentThemeService;
        const served = Effect.map(themes.current, (all) =>
          all.find((theme) => theme.id === "zz-look"),
        );
        assert.deepEqual(yield* served, { id: "zz-look", ...NIGHTFALL_THEME });

        const refused = yield* themes
          .apply({ themeId: "zz-look", theme: large("Too much") })
          .pipe(Effect.flip);
        assert.match(refused.message, /could not be published/);
        assert.deepEqual(yield* served, { id: "zz-look", ...NIGHTFALL_THEME });

        // A new theme that sorts first fits, and the last large one no longer does.
        const before = (yield* themes.current).map((theme) => theme.id);
        const displacing = yield* themes
          .apply({ themeId: "a0-first", theme: large("Displacing") })
          .pipe(Effect.flip);
        assert.match(displacing.message, /could not be published/);
        assert.deepEqual(
          (yield* themes.current).map((theme) => theme.id),
          before,
        );
      }),
    );
  });

  it.effect("does not charge skipped files against the total size limit", () =>
    withEnvironmentThemes(
      {
        ...Object.fromEntries(
          Array.from({ length: 7 }, (_, index) => [
            `junk-${index}.json`,
            "{".repeat(EnvironmentTheme.MAX_THEME_FILE_BYTES),
          ]),
        ),
        "zz-valid.json": encodeThemeFile(NIGHTFALL_THEME),
      },
      Effect.gen(function* () {
        assert.deepEqual(
          (yield* currentThemes).map((theme) => theme.id),
          ["zz-valid"],
        );
      }),
    ),
  );
});
