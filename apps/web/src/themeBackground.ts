import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry, subscribeAtomChanges } from "./rpc/atomRegistry";
import { assetEnvironment } from "./state/assets";
import { localEnvironmentIdAtom } from "./state/primaryEnvironment";
import { themeServerEnvironmentThemesAtom } from "./state/server";
import { environmentSession } from "./state/session";
import { playThemeBackgroundVideo } from "./themeBackgroundVideo";
import { getCustomThemes } from "./themePalette";

const THEME_BACKGROUND_VARIABLE = "--theme-background-image";
const THEME_BACKGROUND_VIDEO_ATTRIBUTE = "data-theme-background-video";
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

// The editor's draft preview replaces the root's theme id, so retries track this instead.
let appliedThemeId: string | undefined;
let shownKey: string | null = null;
let loading: AbortController | null = null;
let objectUrl: string | null = null;
let shownVideo: { readonly element: HTMLVideoElement; readonly stop: () => void } | null = null;

function clear(): void {
  document.documentElement.style.removeProperty(THEME_BACKGROUND_VARIABLE);
  if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  if (shownVideo !== null) {
    shownVideo.stop();
    shownVideo.element.remove();
    // Releases the media resource, which a detached element can otherwise keep downloading.
    shownVideo.element.removeAttribute("src");
    shownVideo.element.load();
    shownVideo = null;
  }
}

function showImage(url: string): void {
  clear();
  document.documentElement.style.setProperty(THEME_BACKGROUND_VARIABLE, `url("${url}")`);
  objectUrl = url;
}

function showVideo(
  url: string,
  events: { readonly loaded: () => void; readonly failed: () => void },
): void {
  clear();
  const element = document.createElement("video");
  element.setAttribute(THEME_BACKGROUND_VIDEO_ATTRIBUTE, "");
  element.setAttribute("aria-hidden", "true");
  element.muted = true;
  element.loop = true;
  element.playsInline = true;
  element.disablePictureInPicture = true;
  element.preload = "auto";
  const listening = new AbortController();
  element.addEventListener("loadeddata", events.loaded, { signal: listening.signal });
  element.addEventListener("error", events.failed, { signal: listening.signal });
  element.src = url;
  document.body.prepend(element);
  const stopPlaying = playThemeBackgroundVideo(element, window);
  shownVideo = {
    element,
    stop: () => {
      listening.abort();
      stopPlaying();
    },
  };
}

async function mintBackgroundUrl(
  environmentId: EnvironmentId,
  themeId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const minted = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: { resource: { _tag: "environment-theme-background", themeId } },
    }),
    { label: "theme background", reportFailure: false, refresh: true, signal },
  );
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (minted._tag !== "Success" || connection._tag === "None") return null;
  return resolveAssetUrl(connection.value.httpBaseUrl, minted.value.relativeUrl);
}

async function downloadImage(url: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  const image = await response.blob();
  return image.type.startsWith("image/") ? URL.createObjectURL(image) : null;
}

/**
 * Shows the image or video published beside `themeId`, or clears it. An image becomes
 * `--theme-background-image`, copied into a blob URL once per revision so the signed URL may
 * expire. A video streams from its signed URL behind the app, and a new URL is minted if it fails.
 */
export function applyThemeBackground(themeId: string | undefined): void {
  if (typeof document === "undefined") return;
  appliedThemeId = themeId;
  const environmentId = appAtomRegistry.get(localEnvironmentIdAtom);
  // A saved theme wins its id over a published one, so the published background is not its.
  const published =
    themeId === undefined || getCustomThemes().some((theme) => theme.id === themeId)
      ? undefined
      : appAtomRegistry
          .get(themeServerEnvironmentThemesAtom)
          ?.find((theme) => theme.id === themeId);
  const revision = published?.background;
  const kind = published?.backgroundKind ?? "image";
  const key =
    environmentId === null || themeId === undefined || revision === undefined
      ? null
      : JSON.stringify([environmentId, themeId, revision, kind]);
  if (key === shownKey) return;
  shownKey = key;
  loading?.abort();
  loading = null;
  // The previous background must not show under the next theme while it loads.
  clear();
  if (environmentId === null || themeId === undefined || key === null) return;
  const controller = new AbortController();
  loading = controller;
  let retries = 0;
  const failed = () => {
    if (controller.signal.aborted) return;
    const delay = RETRY_DELAYS_MS[retries++];
    if (delay !== undefined) {
      // Transient HTTP failures may never produce a browser online event.
      const timer = setTimeout(load, delay);
      controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      return;
    }
    loading = null;
    // Lets the next repaint or `online` event try again.
    shownKey = null;
  };
  const load = () => {
    mintBackgroundUrl(environmentId, themeId, controller.signal)
      .then((url) =>
        url === null || kind === "video" ? url : downloadImage(url, controller.signal),
      )
      .then((url) => {
        if (controller.signal.aborted) {
          if (url !== null && kind === "image") URL.revokeObjectURL(url);
          return;
        }
        if (url === null) return failed();
        loading = null;
        if (kind === "image") return showImage(url);
        showVideo(url, {
          loaded: () => {
            retries = 0;
          },
          // Such as a range request after the signed URL expired. A theme change aborts this.
          failed: () => {
            loading = controller;
            failed();
          },
        });
      }, failed);
  };
  load();
}

/**
 * A new background revision does not change the palette, so it does not repaint the theme.
 * Coming back online retries a download that failed; a shown background is left alone.
 */
export function startThemeBackground(): () => void {
  const reapply = () => applyThemeBackground(appliedThemeId);
  const unsubscribe = subscribeAtomChanges(themeServerEnvironmentThemesAtom, reapply);
  window.addEventListener("online", reapply);
  return () => {
    unsubscribe();
    window.removeEventListener("online", reapply);
    loading?.abort();
    loading = null;
    shownKey = null;
    clear();
  };
}
