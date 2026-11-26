import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

describe("UsageLimitsPooled next refill", () => {
  it("skips elapsed resets while waiting for refreshed account data", async () => {
    function account(instanceId: string, usedPercent: number, resetsAt: string): ServerProvider {
      return {
        ...managedChatGpt(instanceId, instanceId),
        usageLimits: {
          checkedAt,
          windows: [{ id: "weekly", label: "Weekly", kind: "weekly", usedPercent, resetsAt }],
        },
      };
    }
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              account("Work", 20, "2026-10-25T17:00:00.000Z"),
              account("Personal", 60, "2026-10-25T18:00:00.000Z"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T17:30:00Z")} />,
    );
    await expect.element(screen.getByText("↻ +30%", { exact: true })).toBeVisible();

    await screen.rerender(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T18:00:00Z")} />,
    );
    await expect.element(screen.getByText(/^↻ \+\d+%$/)).not.toBeInTheDocument();
  });
});

describe("Usage subscription billing dates", () => {
  it("shows a reported end separately from quota and keeps recorded dates tied to an account", async () => {
    const paid = {
      ...managedChatGpt("paid", "Personal"),
      auth: {
        status: "authenticated" as const,
        type: "chatgpt",
        email: "personal@example.org",
        paidThrough: "2026-11-10T12:00:00Z",
      },
    };
    const claude = {
      ...managedChatGpt("claude", "Work"),
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: {
        status: "authenticated" as const,
        type: "max20",
        label: "Claude Ultra Subscription",
        email: "work@example.org",
        workspaceId: "org-a",
      },
      usageLimits: { checkedAt, windows: [] },
    };
    const view = (providers: ServerProvider[]) => (
      <UsageLimitsPooled
        now={Date.parse(checkedAt)}
        presentations={
          new Map([
            [
              EnvironmentId.make("desk"),
              { entry: { target: { label: "Desk" } }, serverConfig: { providers } },
            ],
          ])
        }
      />
    );
    await using screen = await render(
      view([paid, { ...paid, instanceId: ProviderInstanceId.make("alias") }, claude]),
    );
    await expect.element(screen.getByText(/Last reported paid through/)).toBeVisible();
    expect(document.querySelectorAll("time[datetime='2026-11-10T12:00:00Z']")).toHaveLength(1);
    const date = screen.getByLabelText("Billing date for Work");
    await date.fill("2026-11-17");
    const { workspaceId: _workspace, ...partialAuth } = claude.auth;
    await screen.rerender(
      view([
        claude,
        { ...claude, auth: partialAuth, instanceId: ProviderInstanceId.make("partial") },
      ]),
    );
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(1);
    await expect.element(date).toHaveValue("2026-11-17");
    await screen.rerender(
      view([{ ...claude, auth: { ...claude.auth, email: "other@example.org" } }]),
    );
    await expect.element(date).toHaveValue("");
    await screen.rerender(view([claude]));
    await expect.element(date).toHaveValue("2026-11-17");
    await date.fill("");
    await expect.element(date).toHaveValue("");
  });
});
