import * as ec2 from "@distilled.cloud/aws/ec2";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";

export interface NetworkInterfaceSecurityGroup extends Resource<"Chalk.EC2.NetworkInterfaceSecurityGroup", { networkInterfaceId: string; securityGroupId: string; environment: "nightly" }, { networkInterfaceId: string; securityGroupId: string }> {}
export const NetworkInterfaceSecurityGroup = Resource<NetworkInterfaceSecurityGroup>("Chalk.EC2.NetworkInterfaceSecurityGroup");

export function interfaceGroups(current: readonly string[], group: string, attached: boolean): string[] {
  const groups = attached ? [...new Set([...current, group])] : current.filter((id) => id !== group);
  if (!groups.length) throw new Error("Refusing to remove the interface's last security group.");
  return groups;
}

export const readInterface = Effect.fn(function* (networkInterfaceId: string) {
  const result = yield* ec2.describeNetworkInterfaces({ NetworkInterfaceIds: [networkInterfaceId] }).pipe(Effect.catchTag("InvalidNetworkInterfaceID.NotFound", () => Effect.succeed({ NetworkInterfaces: [] })));
  return result.NetworkInterfaces?.[0];
});

export const readInterfaceGroup = Effect.fn(function* (networkInterfaceId: string, securityGroupId: string) {
  const networkInterface = yield* readInterface(networkInterfaceId);
  return networkInterface?.Groups?.some((group) => group.GroupId === securityGroupId) ? { networkInterfaceId, securityGroupId } : undefined;
});

export const networkInterfaceSecurityGroupProvider = Provider.succeed(NetworkInterfaceSecurityGroup, {
  stables: ["networkInterfaceId", "securityGroupId"],
  list: () => Effect.succeed([]),
  read: ({ olds, output }) => {
    const props = output ?? olds;
    return readInterfaceGroup(props.networkInterfaceId, props.securityGroupId);
  },
  diff: Effect.fn(function* ({ olds, news }) {
    if (isResolved(news) && (olds.networkInterfaceId !== news.networkInterfaceId || olds.securityGroupId !== news.securityGroupId)) return { action: "replace" };
  }),
  reconcile: Effect.fn(function* ({ news }) {
    const networkInterface = yield* readInterface(news.networkInterfaceId);
    const instanceId = networkInterface?.Attachment?.InstanceId;
    if (!instanceId) return yield* Effect.die("The direct Sync interface must exist and be attached to a host.");
    const host = yield* ec2.describeInstances({ InstanceIds: [instanceId] });
    const instance = host.Reservations?.flatMap((reservation) => reservation.Instances ?? [])[0];
    if (!instance?.Tags?.some((tag) => tag.Key === "chalk:environment" && tag.Value === news.environment)) return yield* Effect.die("The interface host is not tagged for the selected environment.");
    const groups = (networkInterface.Groups ?? []).flatMap((group) => (group.GroupId ? [group.GroupId] : []));
    if (!groups.includes(news.securityGroupId)) yield* ec2.modifyNetworkInterfaceAttribute({ NetworkInterfaceId: news.networkInterfaceId, Groups: interfaceGroups(groups, news.securityGroupId, true) });
    return { networkInterfaceId: news.networkInterfaceId, securityGroupId: news.securityGroupId };
  }),
  delete: Effect.fn(function* ({ output }) {
    const networkInterface = yield* readInterface(output.networkInterfaceId);
    const groups = (networkInterface?.Groups ?? []).flatMap((group) => (group.GroupId ? [group.GroupId] : []));
    if (groups.includes(output.securityGroupId)) yield* ec2.modifyNetworkInterfaceAttribute({ NetworkInterfaceId: output.networkInterfaceId, Groups: interfaceGroups(groups, output.securityGroupId, false) });
  }),
});
