import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const query = vi.hoisted(() => vi.fn());
vi.mock(
  import("@t3tools/client-runtime/state/runtime"),
  () =>
    ({
      executeAtomQuery: query,
    }) as never,
);
vi.mock(import("./state/primaryEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { localEnvironmentIdAtom: Atom.make(EnvironmentId.make("host")) } as never;
});
vi.mock(import("./state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    themeServerEnvironmentThemesAtom: Atom.make([
      { id: "nightfall", background: "revision-1" },
      { id: "loop", background: "revision-1", backgroundKind: "video" },
      { id: "scene", background: "revision-1", backgroundPage: "https://scene.example/live" },
    ]),
  } as never;
});
vi.mock(import("./state/session"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentSession: {
      preparedConnectionValueAtom: Atom.family(() =>
        Atom.make({ _tag: "Some", value: { httpBaseUrl: "https://example.com/" } }),
      ),
    },
  } as never;
});
vi.mock(
  import("./state/assets"),
  () =>
    ({
      assetEnvironment: { createUrl: vi.fn() },
    }) as never,
);

import { applyThemeBackground, startThemeBackground } from "./themeBackground";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getThemeDefinition,
  invalidateCustomThemes,
  THEME_PREVIEW_ID,
} from "./themePalette";

const BACKGROUND = "--theme-background-image";
const image = new Blob(["image"], { type: "image/png" });
const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const loaded = async () => ({ ok: true, blob: async () => image });

function fakeVideo(body: Array<unknown>) {
  const attributes = new Map<string, string>();
  const element = Object.assign(new EventTarget(), {
    attributes,
    muted: false,
    loop: false,
    playsInline: false,
    disablePictureInPicture: false,
    preload: "",
    src: "",
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => {
      attributes.delete(name);
      if (name === "src") element.src = "";
    },
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    load: vi.fn(),
    remove: () => {
      const index = body.indexOf(element);
      if (index >= 0) body.splice(index, 1);
    },
  });
  return element;
}

function setup(storage: Record<string, string> = {}) {
  vi.useFakeTimers();
  const properties = new Map<string, string>();
  const browser = Object.assign(new EventTarget(), {
    localStorage: { getItem: (key: string) => storage[key] ?? null },
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
    location: { origin: "https://app.example" },
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  });
  vi.stubGlobal("window", browser);
  invalidateCustomThemes();
  const body: Array<unknown> = [];
  const videos: Array<ReturnType<typeof fakeVideo>> = [];
  const frames: Array<{ src: string; readonly attributes: Map<string, string> }> = [];
  const rootAttributes = new Map<string, string>();
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    body: { prepend: (element: unknown) => body.unshift(element) },
    createElement: (tag: string) => {
      if (tag === "iframe") {
        const attributes = new Map<string, string>();
        const frame = Object.assign(new EventTarget(), {
          src: "",
          attributes,
          contentWindow: { postMessage: vi.fn() },
          setAttribute: (name: string, value: string) => attributes.set(name, value),
          remove: () => {
            const index = body.indexOf(frame);
            if (index >= 0) body.splice(index, 1);
          },
        });
        frames.push(frame);
        return frame;
      }
      expect(tag).toBe("video");
      const video = fakeVideo(body);
      videos.push(video);
      return video;
    },
    documentElement: {
      setAttribute: (name: string, value: string) => rootAttributes.set(name, value),
      removeAttribute: (name: string) => rootAttributes.delete(name),
      dataset: { themeId: "nightfall" },
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    },
  });
  // The video watches visibility through the window it plays in.
  Object.assign(browser, { document: page });
  vi.stubGlobal("document", page);
  query.mockResolvedValue({ _tag: "Success", value: { relativeUrl: "/background.png" } });
  const fetchBackground = vi.fn<() => Promise<unknown>>(offline);
  vi.stubGlobal("fetch", fetchBackground);
  const stop = startThemeBackground();
  return {
    properties,
    body,
    videos,
    frames,
    rootAttributes,
    browser,
    fetchBackground,
    stop,
    [Symbol.dispose]() {
      stop();
      applyThemeBackground(undefined);
      vi.unstubAllGlobals();
      invalidateCustomThemes();
      vi.useRealTimers();
    },
  };
}

describe("theme backgrounds", () => {
  it("shows a published theme's background page beside its image, until the theme changes", async () => {
    using t = setup();
    t.fetchBackground.mockImplementation(loaded);
    applyThemeBackground("scene");
    await vi.advanceTimersByTimeAsync(0);
    const shown = () => t.body.filter((element) => t.frames.includes(element as never));
    expect(shown()).toHaveLength(1);
    expect(t.frames[0]?.src).toBe("https://scene.example/live");
    expect(t.rootAttributes.get("data-theme-background-page")).toBe("loading");
    expect(t.properties.get(BACKGROUND)).toMatch(/^url\("blob:/);

    // The theme file is published again, as a sky that changes every few minutes does.
    applyThemeBackground("scene");
    expect(t.frames).toHaveLength(1);

    applyThemeBackground("nightfall");
    expect(shown()).toHaveLength(0);
    expect(t.rootAttributes.has("data-theme-background-page")).toBe(false);
  });

  it("removes the background page when stopped", () => {
    using t = setup();
    applyThemeBackground("scene");
    expect(t.frames).toHaveLength(1);
    t.stop();
    expect(t.body).toHaveLength(0);
    expect(t.rootAttributes.has("data-theme-background-page")).toBe(false);
  });

  it("retries a failed download after 1, 2, 4 and 8 seconds", async () => {
    using t = setup();
    t.fetchBackground
      .mockImplementationOnce(async () => new Response(null, { status: 503 }))
      .mockImplementationOnce(offline)
      .mockImplementationOnce(offline)
      .mockImplementationOnce(offline)
      .mockImplementation(loaded);

    applyThemeBackground("nightfall");
    await vi.advanceTimersByTimeAsync(0);
    for (const [delay, attempts] of [
      [1_000, 1],
      [2_000, 2],
      [4_000, 3],
      [8_000, 4],
    ] as const) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(t.fetchBackground).toHaveBeenCalledTimes(attempts);
      expect(t.properties.has(BACKGROUND)).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(t.fetchBackground).toHaveBeenCalledTimes(5);
    expect(t.properties.get(BACKGROUND)).toMatch(/^url\("blob:/);
  });

  it("loads the background once when the browser comes back online after retries stop", async () => {
    using t = setup();
    applyThemeBackground("nightfall");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.fetchBackground).toHaveBeenCalledTimes(5);
    expect(t.properties.has(BACKGROUND)).toBe(false);

    t.fetchBackground.mockImplementation(loaded);
    t.browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.properties.get(BACKGROUND)).toMatch(/^url\("blob:/);

    t.browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.fetchBackground).toHaveBeenCalledTimes(6);
  });

  it("keeps the shown background under a draft preview when the browser comes back online", async () => {
    using t = setup();
    t.fetchBackground.mockImplementation(loaded);
    applyThemeBackground("nightfall");
    await vi.advanceTimersByTimeAsync(0);
    const shown = t.properties.get(BACKGROUND);
    expect(shown).toMatch(/^url\("blob:/);

    document.documentElement.dataset.themeId = THEME_PREVIEW_ID;
    t.browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.properties.get(BACKGROUND)).toBe(shown);
  });

  it.each(["theme change", "disposal"])("stops retrying after %s", async (reason) => {
    using t = setup();
    applyThemeBackground("nightfall");
    await vi.advanceTimersByTimeAsync(0);
    if (reason === "theme change") applyThemeBackground(undefined);
    else t.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.fetchBackground).toHaveBeenCalledTimes(1);
  });

  it("plays a video background from its signed URL, and mints a new one when it fails", async () => {
    using t = setup();
    query.mockResolvedValue({ _tag: "Success", value: { relativeUrl: "/background.webm" } });
    applyThemeBackground("loop");
    await vi.advanceTimersByTimeAsync(0);
    // A video streams in ranges, so it is never downloaded whole.
    expect(t.fetchBackground).not.toHaveBeenCalled();
    expect(t.properties.has(BACKGROUND)).toBe(false);
    const [first] = t.videos;
    expect(first).toMatchObject({
      src: "https://example.com/background.webm",
      muted: true,
      loop: true,
      playsInline: true,
    });
    expect(first?.attributes.has("data-theme-background-video")).toBe(true);
    expect(first?.attributes.get("aria-hidden")).toBe("true");
    expect(t.body).toEqual([first]);
    expect(first?.play).toHaveBeenCalledTimes(1);

    // Such as a range request after the signed URL expired.
    first?.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(999);
    expect(t.videos).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.videos).toHaveLength(2);
    expect(t.body).toEqual([t.videos[1]]);
    expect(first).toMatchObject({ src: "" });

    applyThemeBackground("nightfall");
    expect(t.body).toEqual([]);
    expect(t.videos[1]?.pause).toHaveBeenCalled();
    expect(t.videos[1]?.load).toHaveBeenCalled();
  });

  it("shows no published background when a saved theme shares its id", async () => {
    using t = setup({
      [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
        {
          id: "nightfall",
          label: "Nightfall",
          appearance: "dark",
          colors: { canvas: "#162327", accent: "#cc3344" },
        },
      ]),
    });
    t.fetchBackground.mockImplementation(loaded);
    expect(getThemeDefinition("nightfall")?.colors.accent).toBeDefined();
    applyThemeBackground("nightfall");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetchBackground).not.toHaveBeenCalled();
    expect(t.properties.has(BACKGROUND)).toBe(false);
  });
});
