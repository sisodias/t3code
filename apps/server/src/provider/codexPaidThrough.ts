import * as DateTime from "effect/DateTime";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeLogin = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      tokens: Schema.Struct({
        id_token: Schema.String,
        account_id: Schema.optional(Schema.String),
      }),
    }),
  ),
);
const decodeClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      email: Schema.String,
      "https://api.openai.com/auth": Schema.Struct({
        chatgpt_account_id: Schema.String,
        chatgpt_plan_type: Schema.String,
        chatgpt_subscription_active_until: Schema.String,
      }),
    }),
  ),
);

interface CodexBillingIdentity {
  readonly email: string;
  readonly planType: string;
  readonly workspaceId: string | undefined;
}

/** Display-only metadata. The live account probe establishes identity; these claims never authorize access. */
export function codexPaidThrough(login: string, account: CodexBillingIdentity): string | undefined {
  const stored = Option.getOrUndefined(decodeLogin(login));
  const parts = stored?.tokens.id_token.split(".");
  if (!stored || parts?.length !== 3 || !parts[1]) return undefined;
  const payload = Base64Url.decodeString(parts[1]);
  if (payload._tag !== "Success") return undefined;
  const claims = Option.getOrUndefined(decodeClaims(payload.success));
  if (!claims || claims.email.trim().toLowerCase() !== account.email.trim().toLowerCase())
    return undefined;
  const plan = claims["https://api.openai.com/auth"];
  if (
    plan.chatgpt_plan_type !== account.planType ||
    (stored.tokens.account_id && stored.tokens.account_id !== plan.chatgpt_account_id) ||
    (account.workspaceId
      ? account.workspaceId !== plan.chatgpt_account_id
      : !["plus", "pro", "prolite", "promax", "go"].includes(account.planType))
  )
    return undefined;
  const until = plan.chatgpt_subscription_active_until;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(until))
    return undefined;
  // Date parsers may normalize a nonexistent day (e.g. February 30) into the next month.
  const day = until.slice(0, 10);
  const midnight = DateTime.make(day + "T00:00:00Z");
  if (Option.isNone(midnight) || DateTime.formatIso(midnight.value).slice(0, 10) !== day)
    return undefined;
  return Option.getOrUndefined(Option.map(DateTime.make(until), DateTime.formatIso));
}

export const readCodexPaidThrough = Effect.fn("readCodexPaidThrough")(function* (
  codexHome: string,
  account: CodexBillingIdentity,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(codexHome, "auth.json")).pipe(
    Effect.timeout("1 second"),
    Effect.map((login) => codexPaidThrough(login, account)),
    Effect.orElseSucceed(() => undefined),
  );
});
