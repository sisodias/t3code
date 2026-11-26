/**
 * A theme's live background page in a sandboxed cross-origin frame behind the app: its own process,
 * no input. Shown once it posts `{ type: "t3-background-page", state: "ready" }`; told `paused` or
 * `running` with the document's visibility. Protocol and theme CSS: docs/user/appearance.md.
 */

export const THEME_BACKGROUND_PAGE_ATTRIBUTE = "data-theme-background-page";
export const THEME_BACKGROUND_PAGE_FRAME_ATTRIBUTE = "data-theme-background-page-frame";
const THEME_BACKGROUND_PAGE_MESSAGE = "t3-background-page";
export const READY_TIMEOUT_MS = 20_000;
export const RETRY_DELAYS_MS = [10_000, 60_000, 300_000];

export type ThemeBackgroundPageState = "loading" | "ready" | "failed";

export interface ThemeBackgroundPageView {
  readonly location: Pick<Location, "origin">;
  readonly matchMedia: Window["matchMedia"];
  readonly addEventListener: Window["addEventListener"];
  readonly removeEventListener: Window["removeEventListener"];
  readonly setTimeout: Window["setTimeout"];
  readonly clearTimeout: Window["clearTimeout"];
  readonly document: Pick<
    Document,
    | "visibilityState"
    | "documentElement"
    | "body"
    | "createElement"
    | "addEventListener"
    | "removeEventListener"
  >;
}

/** The page's origin when `url` may be a background page here, else null. */
export function backgroundPageOrigin(url: string, appOrigin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  // Sandboxed with allow-same-origin, a page from the app's own origin could reach into the app.
  if (parsed.origin === appOrigin) return null;
  return parsed.origin;
}

function isReady(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === THEME_BACKGROUND_PAGE_MESSAGE &&
    (data as { state?: unknown }).state === "ready"
  );
}

/**
 * Shows the page at `url` behind the app until the returned function is called. Returns a no-op
 * and shows nothing when `url` cannot be a background page here.
 */
export function showThemeBackgroundPage(url: string, view: ThemeBackgroundPageView): () => void {
  const origin = backgroundPageOrigin(url, view.location.origin);
  if (origin === null) return () => {};
  const root = view.document.documentElement;
  const reducedMotion = view.matchMedia("(prefers-reduced-motion: reduce)");
  let frame: HTMLIFrameElement | null = null;
  let timer: number | null = null;
  let retries = 0;
  let ready = false;

  const setState = (state: ThemeBackgroundPageState | null) => {
    if (state === null) root.removeAttribute(THEME_BACKGROUND_PAGE_ATTRIBUTE);
    else root.setAttribute(THEME_BACKGROUND_PAGE_ATTRIBUTE, state);
  };
  const stopTimer = () => {
    if (timer !== null) view.clearTimeout(timer);
    timer = null;
  };
  const post = () => {
    if (!ready || frame === null) return;
    const state = view.document.visibilityState === "hidden" ? "paused" : "running";
    frame.contentWindow?.postMessage({ type: THEME_BACKGROUND_PAGE_MESSAGE, state }, origin);
  };
  const unmount = () => {
    stopTimer();
    ready = false;
    frame?.remove();
    frame = null;
  };
  const fail = () => {
    unmount();
    setState("failed");
    // Never for good: a window nobody can see (a closed laptop lid) gives the page no frames to draw.
    const delay = RETRY_DELAYS_MS[Math.min(retries++, RETRY_DELAYS_MS.length - 1)]!;
    timer = view.setTimeout(mount, delay);
  };
  const waitForReady = () => {
    stopTimer();
    timer = view.setTimeout(fail, READY_TIMEOUT_MS);
  };
  function mount(): void {
    unmount();
    if (reducedMotion.matches) return setState(null);
    // oxlint-disable-next-line react/iframe-missing-sandbox -- sandboxed by setAttribute below.
    const element = view.document.createElement("iframe");
    element.setAttribute(THEME_BACKGROUND_PAGE_FRAME_ATTRIBUTE, "");
    element.setAttribute("sandbox", "allow-scripts allow-same-origin");
    element.setAttribute("allow", "");
    element.setAttribute("referrerpolicy", "no-referrer");
    element.setAttribute("tabindex", "-1");
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("inert", "");
    // A later load is the page reloading or navigating itself: wait for it to be ready again.
    element.addEventListener("load", () => {
      if (frame !== element || !ready) return;
      ready = false;
      setState("loading");
      waitForReady();
    });
    element.src = url;
    frame = element;
    setState("loading");
    waitForReady();
    view.document.body.prepend(element);
  }

  const onMessage = (event: MessageEvent) => {
    if (frame === null || event.source !== frame.contentWindow || event.origin !== origin) return;
    if (!isReady(event.data) || ready) return;
    stopTimer();
    ready = true;
    retries = 0;
    setState("ready");
    post();
  };
  const onOnline = () => {
    if (frame === null && !reducedMotion.matches) {
      retries = 0;
      mount();
    }
  };
  const onMotion = () => {
    retries = 0;
    if (reducedMotion.matches) {
      unmount();
      setState(null);
    } else if (frame === null) mount();
  };

  view.addEventListener("message", onMessage);
  view.addEventListener("online", onOnline);
  view.document.addEventListener("visibilitychange", post);
  reducedMotion.addEventListener("change", onMotion);
  mount();

  return () => {
    view.removeEventListener("message", onMessage);
    view.removeEventListener("online", onOnline);
    view.document.removeEventListener("visibilitychange", post);
    reducedMotion.removeEventListener("change", onMotion);
    unmount();
    setState(null);
  };
}
