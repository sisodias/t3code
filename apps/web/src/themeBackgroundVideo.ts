/**
 * Plays a theme's background video only while the page is visible and the system allows motion,
 * and resumes it when both hold again. Returns a function that pauses it and stops watching.
 */
export function playThemeBackgroundVideo(
  video: Pick<HTMLVideoElement, "play" | "pause">,
  view: Pick<Window, "matchMedia"> & {
    readonly document: Pick<Document, "visibilityState"> & EventTarget;
  },
): () => void {
  const reducedMotion = view.matchMedia("(prefers-reduced-motion: reduce)");
  const sync = () => {
    if (reducedMotion.matches || view.document.visibilityState === "hidden") video.pause();
    // A pause before playback starts rejects the pending play().
    else video.play().catch(() => {});
  };
  sync();
  reducedMotion.addEventListener("change", sync);
  view.document.addEventListener("visibilitychange", sync);
  return () => {
    reducedMotion.removeEventListener("change", sync);
    view.document.removeEventListener("visibilitychange", sync);
    video.pause();
  };
}
