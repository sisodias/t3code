import { describe, expect, it, vi } from "vite-plus/test";

import { playThemeBackgroundVideo } from "./themeBackgroundVideo";

function setup(initial: { readonly reducedMotion?: boolean; readonly hidden?: boolean } = {}) {
  const motion = Object.assign(new EventTarget(), { matches: initial.reducedMotion ?? false });
  const page = Object.assign(new EventTarget(), {
    visibilityState: (initial.hidden ? "hidden" : "visible") as DocumentVisibilityState,
  });
  const matchMedia = vi.fn((_query: string) => motion as unknown as MediaQueryList);
  let state: "unstarted" | "playing" | "paused" = "unstarted";
  const video = {
    play: vi.fn(async () => {
      state = "playing";
    }),
    pause: vi.fn(() => {
      state = "paused";
    }),
  };
  const stop = playThemeBackgroundVideo(video, { matchMedia, document: page });
  return {
    video,
    matchMedia,
    stop,
    get state() {
      return state;
    },
    reduceMotion(reduce: boolean) {
      motion.matches = reduce;
      motion.dispatchEvent(new Event("change"));
    },
    hide(hidden: boolean) {
      page.visibilityState = hidden ? "hidden" : "visible";
      page.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

describe("theme background video", () => {
  it("plays at once while the page is visible and motion is allowed", () => {
    const t = setup();
    expect(t.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(t.state).toBe("playing");
  });

  it("stays paused under reduced motion, and plays once motion is allowed", () => {
    const t = setup({ reducedMotion: true });
    expect(t.state).toBe("paused");
    expect(t.video.play).not.toHaveBeenCalled();

    t.reduceMotion(false);
    expect(t.state).toBe("playing");
    t.reduceMotion(true);
    expect(t.state).toBe("paused");
  });

  it("pauses while the page is hidden and resumes when it is shown", () => {
    const t = setup();
    t.hide(true);
    expect(t.state).toBe("paused");
    t.hide(false);
    expect(t.state).toBe("playing");
  });

  it("starts paused in a hidden page", () => {
    const t = setup({ hidden: true });
    expect(t.state).toBe("paused");
    expect(t.video.play).not.toHaveBeenCalled();
  });

  it("resumes only when the page is visible and motion is allowed", () => {
    const t = setup();
    t.reduceMotion(true);
    t.hide(true);
    t.hide(false);
    expect(t.state).toBe("paused");
    expect(t.video.play).toHaveBeenCalledTimes(1);

    t.reduceMotion(false);
    expect(t.state).toBe("playing");
  });

  it("ignores a play that a pause interrupts", async () => {
    const t = setup({ hidden: true });
    t.video.play.mockRejectedValueOnce(new DOMException("interrupted by pause()", "AbortError"));
    t.hide(false);
    // A rejection left unhandled would fail the run.
    await Promise.resolve();
    expect(t.video.play).toHaveBeenCalledTimes(1);
  });

  it("pauses and stops watching when stopped", () => {
    const t = setup();
    t.stop();
    expect(t.state).toBe("paused");

    t.hide(true);
    t.hide(false);
    t.reduceMotion(true);
    t.reduceMotion(false);
    expect(t.state).toBe("paused");
    expect(t.video.play).toHaveBeenCalledTimes(1);
  });
});
