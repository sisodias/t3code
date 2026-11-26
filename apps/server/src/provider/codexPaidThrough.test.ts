import { describe, expect, it } from "vite-plus/test";
import { codexPaidThrough } from "./codexPaidThrough.ts";

const account = { email: "example@example.org", planType: "plus", workspaceId: "personal" };
const until = "2025-04-02T20:56:31+00:00";
function fixture(date: string, planType = "plus") {
  const payload = Buffer.from(
    JSON.stringify({
      email: account.email,
      "https://api.openai.com/auth": {
        chatgpt_plan_type: planType,
        chatgpt_account_id: "personal",
        chatgpt_subscription_active_until: date,
      },
    }),
  ).toString("base64url");
  return JSON.stringify({
    tokens: { id_token: `header.${payload}.signature`, account_id: "personal" },
  });
}
describe("Codex subscription period", () => {
  it("preserves the reported end instant even when it has passed", () => {
    expect(codexPaidThrough(fixture(until), account)).toBe("2025-04-02T20:56:31.000Z");
  });
  it("omits other workspaces, users, stale tiers and ambiguous business identities", () => {
    for (const other of [
      { ...account, workspaceId: "work" },
      { ...account, email: "other@example.org" },
      { ...account, planType: "pro" },
    ]) {
      expect(codexPaidThrough(fixture(until), other)).toBeUndefined();
    }
    expect(
      codexPaidThrough(fixture(until, "team"), {
        ...account,
        planType: "team",
        workspaceId: undefined,
      }),
    ).toBeUndefined();
  });
  it("tolerates absent credentials and unusable dates without breaking the probe", () => {
    for (const login of [
      "{}",
      "invalid",
      fixture("invalid"),
      fixture("2025-04-02"),
      fixture("2025-02-30T00:00:00Z"),
    ]) {
      expect(codexPaidThrough(login, account)).toBeUndefined();
    }
  });
});
