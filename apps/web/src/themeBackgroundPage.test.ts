import { describe, expect, it, vi } from "vite-plus/test";

import {
  backgroundPageOrigin,
  READY_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  showThemeBackgroundPage,
  THEME_BACKGROUND_PAGE_ATTRIBUTE,
  THEME_BACKGROUND_PAGE_FRAME_ATTRIBUTE,
  type ThemeBackgroundPageView,
} from "./themeBackgroundPage";

const PAGE = "https://scene.example/live?embed=1";
const PAGE_ORIGIN = "https://scene.example";
const APP_ORIGIN = "t3code://app";

function setup(initial: { readonly reducedMotion?: boolean; readonly hidden?: boolean } = {}) {
  const win = new EventTarget();
  const motion = Object.assign(new EventTarget(), { matches: initial.reducedMotion ?? false });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: (initial.hidden ? "hidden" : "visible") as DocumentVisibilityState,
  });
  const rootAttributes = new Map<string, string>();
  const body: Array<ReturnType<typeof fakeFrame>> = [];
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
  let now = 0;
  let nextTimer = 1;

  function fakeFrame() {
    const attributes = new Map<string, string>();
    const contentWindow = { postMessage: vi.fn() };
    const element = Object.assign(new EventTarget(), {
      attributes,
      contentWindow,
      src: "",
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      remove: () => {
        const index = body.indexOf(element);
        if (index >= 0) body.splice(index, 1);
      },
    });
    return element;
  }

  const view = {
    location: { origin: APP_ORIGIN },
    matchMedia: vi.fn(() => motion),
    addEventListener: win.addEventListener.bind(win),
    removeEventListener: win.removeEventListener.bind(win),
    setTimeout: (run: () => void, ms: number) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id: never) => {
      timers.delete(id as unknown as number);
    },
    document: Object.assign(doc, {
      documentElement: {
        setAttribute: (name: string, value: string) => rootAttributes.set(name, value),
        removeAttribute: (name: string) => rootAttributes.delete(name),
      },
      body: { prepend: (frame: ReturnType<typeof fakeFrame>) => body.unshift(frame) },
      createElement: () => fakeFrame(),
    }),
  } as unknown as ThemeBackgroundPageView;

  return {
    view,
    body,
    get state() {
      return rootAttributes.get(THEME_BACKGROUND_PAGE_ATTRIBUTE);
    },
    get frame() {
      return body[0];
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .toSorted((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        // Timers set by this one count from when it ran.
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
    message(data: unknown, from: { readonly source?: unknown; readonly origin?: string } = {}) {
      win.dispatchEvent(
        Object.assign(new Event("message"), {
          data,
          source: "source" in from ? from.source : body[0]?.contentWindow,
          origin: from.origin ?? PAGE_ORIGIN,
        }),
      );
    },
    ready() {
      this.message({ type: "t3-background-page", state: "ready" });
    },
    hide(hidden: boolean) {
      doc.visibilityState = hidden ? "hidden" : "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    reduceMotion(reduce: boolean) {
      motion.matches = reduce;
      motion.dispatchEvent(new Event("change"));
    },
    online() {
      win.dispatchEvent(new Event("online"));
    },
  };
}

describe("backgroundPageOrigin", () => {
  it("accepts https pages and http pages on loopback", () => {
    expect(backgroundPageOrigin(PAGE, APP_ORIGIN)).toBe(PAGE_ORIGIN);
    expect(backgroundPageOrigin("http://localhost:5173/scene", APP_ORIGIN)).toBe(
      "http://localhost:5173",
    );
    expect(backgroundPageOrigin("http://127.0.0.1:8080/", APP_ORIGIN)).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("refuses other schemes, remote http, credentials, and the app's own origin", () => {
    expect(backgroundPageOrigin("http://scene.example/", APP_ORIGIN)).toBeNull();
    expect(backgroundPageOrigin("javascript:alert(1)", APP_ORIGIN)).toBeNull();
    expect(backgroundPageOrigin("data:text/html,hi", APP_ORIGIN)).toBeNull();
    expect(backgroundPageOrigin("https://user:pass@scene.example/", APP_ORIGIN)).toBeNull();
    expect(backgroundPageOrigin("not a url", APP_ORIGIN)).toBeNull();
    expect(backgroundPageOrigin("http://localhost:3773/scene", "http://localhost:3773")).toBeNull();
  });
});

describe("theme background page", () => {
  it("loads the page in a sandboxed frame that takes no input, and waits for it", () => {
    const t = setup();
    showThemeBackgroundPage(PAGE, t.view);

    expect(t.body).toHaveLength(1);
    expect(t.frame?.src).toBe(PAGE);
    expect(Object.fromEntries(t.frame?.attributes ?? [])).toEqual({
      [THEME_BACKGROUND_PAGE_FRAME_ATTRIBUTE]: "",
      sandbox: "allow-scripts allow-same-origin",
      allow: "",
      referrerpolicy: "no-referrer",
      tabindex: "-1",
      "aria-hidden": "true",
      inert: "",
    });
    expect(t.state).toBe("loading");
  });

  it("is ready only on the page's own ready message, then tells it to run", () => {
    const t = setup();
    showThemeBackgroundPage(PAGE, t.view);

    t.message({ type: "t3-background-page", state: "ready" }, { origin: "https://evil.example" });
    t.message({ type: "t3-background-page", state: "ready" }, { source: {} });
    t.message({ type: "other", state: "ready" });
    expect(t.state).toBe("loading");

    t.ready();
    expect(t.state).toBe("ready");
    expect(t.frame?.contentWindow.postMessage).toHaveBeenCalledWith(
      { type: "t3-background-page", state: "running" },
      PAGE_ORIGIN,
    );
  });

  it("pauses the page while the document is hidden and runs it when shown", () => {
    const t = setup();
    showThemeBackgroundPage(PAGE, t.view);
    t.ready();
    const post = t.frame!.contentWindow.postMessage;

    t.hide(true);
    expect(post).toHaveBeenLastCalledWith(
      { type: "t3-background-page", state: "paused" },
      PAGE_ORIGIN,
    );
    t.hide(false);
    expect(post).toHaveBeenLastCalledWith(
      { type: "t3-background-page", state: "running" },
      PAGE_ORIGIN,
    );
  });

  it("starts paused when the page becomes ready while the document is hidden", () => {
    const t = setup({ hidden: true });
    showThemeBackgroundPage(PAGE, t.view);
    t.ready();
    expect(t.frame?.contentWindow.postMessage).toHaveBeenCalledWith(
      { type: "t3-background-page", state: "paused" },
      PAGE_ORIGIN,
    );
  });

  it("removes a page that is never ready and tries again later", () => {
    const t = setup();
    showThemeBackgroundPage(PAGE, t.view);

    t.advance(READY_TIMEOUT_MS);
    expect(t.state).toBe("failed");
    expect(t.body).toHaveLength(0);

    t.advance(RETRY_DELAYS_MS[0]!);
    expect(t.state).toBe("loading");
    expect(t.body).toHaveLength(1);
    t.ready();
    expect(t.state).toBe("ready");
  });

  it("keeps trying at its last delay, and at once when the browser is back online", () => {
    const t = setup();
    showThemeBackgroundPage(PAGE, t.view);
    for (const delay of RETRY_DELAYS_MS) t.advance(READY_TIMEOUT_MS + delay);
    t.advance(READY_TIMEOUT_MS);
    expect(t.state).toBe("failed");
    expect(t.body).toHaveLength(0);

    t.advance(RETRY_DELAYS_MS.at(-1)!);
    expect(t.state).toBe("loading");
    expect(t.body).toHaveLength(1);
    t.advance(READY_TIMEOUT_MS);
    expect(t.state).toBe("failed");

    t.online();
    expect(t.state).toBe("loading");
    expect(t.body).toHaveLength(1);
    t.ready();
    expect(t.state).toBe("ready");
  });

  it("waits for ready again when the page reloads itself", () => {
    const t = setup();
    showThemeBackgroundPage(PAGE, t.view);
    t.frame!.dispatchEvent(new Event("load"));
    expect(t.state).toBe("loading");
    t.ready();

    t.frame!.dispatchEvent(new Event("load"));
    expect(t.state).toBe("loading");
    t.advance(READY_TIMEOUT_MS);
    expect(t.state).toBe("failed");
  });

  it("shows no frame under reduced motion, and follows the setting", () => {
    const t = setup({ reducedMotion: true });
    showThemeBackgroundPage(PAGE, t.view);
    expect(t.body).toHaveLength(0);
    expect(t.state).toBeUndefined();

    t.reduceMotion(false);
    expect(t.body).toHaveLength(1);
    t.ready();
    t.reduceMotion(true);
    expect(t.body).toHaveLength(0);
    expect(t.state).toBeUndefined();
  });

  it("shows nothing for a page it may not load", () => {
    const t = setup();
    const stop = showThemeBackgroundPage("http://scene.example/", t.view);
    expect(t.body).toHaveLength(0);
    expect(t.state).toBeUndefined();
    stop();
  });

  it("removes the frame, the state, and its listeners when stopped", () => {
    const t = setup();
    const stop = showThemeBackgroundPage(PAGE, t.view);
    t.ready();
    stop();
    expect(t.body).toHaveLength(0);
    expect(t.state).toBeUndefined();

    t.online();
    t.reduceMotion(false);
    t.advance(READY_TIMEOUT_MS + RETRY_DELAYS_MS[0]!);
    expect(t.body).toHaveLength(0);
  });
});
