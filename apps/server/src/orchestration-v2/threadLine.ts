import type { OrchestrationV2ThreadLine } from "@t3tools/contracts";

/** A line in the fleet; the whole message is in the thread. */
export const THREAD_LINE_CHARS = 160;

/**
 * Text on one line, cut to fit: a heading ends in a colon and code fences go. Long text is cut
 * before it is folded.
 */
export const oneLine = (text: string) =>
  text
    .slice(0, THREAD_LINE_CHARS * 4)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("```"))
    .map((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line)?.[1];
      return heading === undefined || /[.:!?]$/.test(heading) ? line : `${heading}:`;
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, THREAD_LINE_CHARS);

/** A timeline item's line when it is a message, a person's or the agent's; null otherwise. */
export function threadLineOf(
  type: string,
  text: string | null | undefined,
): OrchestrationV2ThreadLine | null {
  if (type !== "user_message" && type !== "assistant_message" && type !== "proposed_plan") {
    return null;
  }
  const line = oneLine(text ?? "");
  return line === "" ? null : { author: type === "user_message" ? "user" : "agent", text: line };
}
