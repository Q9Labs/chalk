import * as iam from "@distilled.cloud/aws/iam";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import { Resource } from "alchemy/Resource";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import { canonicalPolicy } from "./aws-bucket-policy.ts";
import { parseStage } from "../platform/stages.ts";

interface RoleInlinePolicy extends Resource<"Chalk.IAM.RoleInlinePolicy", { roleName: string; policyName: string; policy: string }, { roleName: string; policyName: string; policy: string }> {}
export const RoleInlinePolicy = Resource<RoleInlinePolicy>("Chalk.IAM.RoleInlinePolicy");

const readPolicy = Effect.fn(function* (roleName: string, policyName: string) {
  const current = yield* iam.getRolePolicy({ RoleName: roleName, PolicyName: policyName }).pipe(Effect.catchTag("NoSuchEntityException", () => Effect.undefined));
  return current?.PolicyDocument ? { roleName, policyName, policy: canonicalPolicy(decodeURIComponent(current.PolicyDocument)) } : undefined;
});

export const roleInlinePolicyProvider = Provider.succeed(RoleInlinePolicy, {
  stables: ["roleName", "policyName"],
  list: () => Effect.succeed([]),
  read: ({ olds, output }) => readPolicy(output?.roleName ?? olds.roleName, output?.policyName ?? olds.policyName),
  diff: Effect.fn(function* ({ olds, news }) {
    if (isResolved(news) && (olds.roleName !== news.roleName || olds.policyName !== news.policyName)) return { action: "replace" };
  }),
  reconcile: Effect.fn(function* ({ news }) {
    const policy = canonicalPolicy(news.policy);
    const current = yield* readPolicy(news.roleName, news.policyName);
    if (current?.policy !== policy) yield* iam.putRolePolicy({ RoleName: news.roleName, PolicyName: news.policyName, PolicyDocument: policy });
    return { roleName: news.roleName, policyName: news.policyName, policy };
  }),
  delete: Effect.fn(function* ({ output }) {
    if (parseStage(yield* Stage).kind === "production") return yield* Effect.die("Refusing to delete a production API role policy");
    yield* iam.deleteRolePolicy({ RoleName: output.roleName, PolicyName: output.policyName }).pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
  }),
});
