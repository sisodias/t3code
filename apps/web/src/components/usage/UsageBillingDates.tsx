import {
  CHATGPT_USAGE_URL,
  nativeUsageAccountIdentity,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";

const recordedDate = Schema.String.check(Schema.isPattern(/^(?:\d{4}-\d{2}-\d{2})?$/));
const billingDateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
type BillingAccount = {
  key: string;
  name: string;
  provider: "ChatGPT" | "Claude";
  paidThrough: string | undefined;
  checkedAt: string;
  canRecord: boolean;
};

function billingAccounts(presentations: LimitPresentations) {
  const rows = new Map<string, BillingAccount>();
  const resolveIdentity = nativeUsageAccountIdentity(presentations);
  for (const [environmentId, presentation] of presentations) {
    for (const instance of presentation.serverConfig?.providers ?? []) {
      const auth = instance.auth;
      if (
        !instance.enabled ||
        auth.status !== "authenticated" ||
        auth.endpoint ||
        auth.label === "ChatGPT Free Subscription"
      )
        continue;
      const chatGpt =
        instance.driver === "codex" &&
        (auth.type === "chatgpt" || instance.usageLimits?.externalUsage?.url === CHATGPT_USAGE_URL);
      const claude =
        instance.driver === "claudeAgent" &&
        auth.label?.startsWith("Claude ") &&
        auth.label.endsWith(" Subscription") &&
        auth.label !== "Claude Free Subscription";
      if (!chatGpt && !claude) continue;
      const identity = resolveIdentity(instance);
      const key = identity ?? JSON.stringify([environmentId, instance.instanceId]);
      const previous = rows.get(key);
      const paidThrough =
        auth.paidThrough && Number.isFinite(Date.parse(auth.paidThrough))
          ? auth.paidThrough
          : undefined;
      // Several environments can probe the same subscription. Prefer the freshest dated observation.
      if (
        previous &&
        (!paidThrough || (previous.paidThrough && previous.checkedAt >= instance.checkedAt))
      )
        continue;
      rows.set(key, {
        key,
        name: instance.displayName?.trim() || instance.instanceId,
        provider: chatGpt ? "ChatGPT" : "Claude",
        paidThrough,
        checkedAt: instance.checkedAt,
        canRecord: Boolean(identity),
      });
    }
  }
  return [...rows.values()];
}

function BillingRow({ account, now }: { readonly account: BillingAccount; readonly now: number }) {
  const gt = useGT();
  const [saved, setSaved] = useLocalStorage(
    `t3code:billing-date:v1:${account.key}`,
    "",
    recordedDate,
  );
  const allowEntry =
    account.canRecord && (!account.paidThrough || Date.parse(account.paidThrough) < now);
  const url =
    account.provider === "Claude"
      ? "https://claude.ai/settings/billing"
      : "https://chatgpt.com/#settings/Account";
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2 text-sm">
      <div className="min-w-0">
        <span className="break-words font-medium">{account.name}</span>
        <span className="ms-2 text-xs text-muted-foreground">{account.provider}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {account.paidThrough ? (
          <time dateTime={account.paidThrough}>
            {gt("Last reported paid through {date}", {
              date: billingDateFormat.format(new Date(account.paidThrough)),
            })}
          </time>
        ) : null}
        {allowEntry ? (
          <label className="flex items-center gap-2 text-muted-foreground">
            <T>Your date</T>
            <input
              type="date"
              aria-label={gt("Billing date for {account}", { account: account.name })}
              aria-description={gt("Saved on this device")}
              value={saved}
              className="rounded-md border border-input bg-transparent px-2 py-1 text-foreground"
              onChange={(event) => setSaved(event.currentTarget.value)}
            />
          </label>
        ) : !account.paidThrough ? (
          <span className="text-muted-foreground">
            <T>Date unavailable</T>
          </span>
        ) : null}
        <Button
          variant="ghost-muted"
          size="xs"
          aria-label={gt("Open {provider} billing for {account}", {
            provider: account.provider,
            account: account.name,
          })}
          onClick={() => void ensureLocalApi().shell.openExternal(url)}
        >
          <T>Billing</T>
          <ExternalLinkIcon className="size-3" aria-hidden />
        </Button>
      </div>
    </li>
  );
}

export function UsageBillingDates({
  presentations,
  now,
}: {
  readonly presentations: LimitPresentations;
  readonly now: number;
}) {
  const accounts = billingAccounts(presentations);
  if (accounts.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">
        <T>Subscription billing dates</T>
      </h2>
      <ul className="divide-y divide-border rounded-xl border px-4">
        {accounts.map((account) => (
          <BillingRow key={account.key} account={account} now={now} />
        ))}
      </ul>
    </section>
  );
}
