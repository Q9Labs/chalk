import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { nightly, awsProviders, state } from "../platform/config.ts";
import { NetworkInterfaceSecurityGroup, networkInterfaceSecurityGroupProvider } from "../providers/aws-network-interface-security-group.ts";
import { directSyncConfig } from "./config.ts";

const providers = awsProviders(process.env.CHALK_DIRECT_SYNC_AWS_REGION ?? "ap-southeast-1");
export default Alchemy.Stack(
  "direct-sync",
  {
    providers: Layer.mergeAll(providers, Cloudflare.providers(), networkInterfaceSecurityGroupProvider.pipe(Layer.provide(providers))),
    state,
  },
  Effect.gen(function* () {
    const environment = yield* nightly;
    const config = Schema.decodeUnknownSync(directSyncConfig)({
      instanceId: process.env.CHALK_DIRECT_SYNC_INSTANCE_ID,
      hostname: process.env.CHALK_DIRECT_SYNC_HOST,
      zoneId: process.env.CLOUDFLARE_ZONE_ID,
      ipv4Address: process.env.CHALK_DIRECT_SYNC_IPV4,
      ...(process.env.CHALK_DIRECT_SYNC_IPV6 ? { ipv6Address: process.env.CHALK_DIRECT_SYNC_IPV6 } : {}),
    });
    // Invoke the read-only lookup providers directly because the postcondition must
    // fail before any resources are declared, not while an Output is reconciled.
    const instanceProvider = yield* Provider.findProvider(AWS.EC2.Instance);
    const subnetProvider = yield* Provider.findProvider(AWS.EC2.Subnet);
    if (!instanceProvider.lookup || !subnetProvider.lookup) return yield* Effect.die("Missing EC2 lookup provider.");
    const host = yield* instanceProvider.lookup({ instanceId: config.instanceId });
    if (host?.tags["chalk:environment"] !== environment) return yield* Effect.die("The instance is not tagged for the selected environment.");
    if (!host.subnetId) return yield* Effect.die("The direct Sync host has no subnet.");
    const subnet = yield* subnetProvider.lookup({ subnetId: host.subnetId });
    if (!subnet) return yield* Effect.die("The direct Sync subnet no longer exists.");
    // Instance.lookup does not expose the primary network interface at beta.87.
    const interfaces = yield* ec2.describeNetworkInterfaces({
      Filters: [
        { Name: "attachment.instance-id", Values: [config.instanceId] },
        { Name: "attachment.device-index", Values: ["0"] },
      ],
    });
    const primary = interfaces.NetworkInterfaces?.[0];
    if (interfaces.NetworkInterfaces?.length !== 1 || !primary?.NetworkInterfaceId) return yield* Effect.die("Expected exactly one primary interface for the direct Sync host.");
    const group = yield* AWS.EC2.SecurityGroup("DirectSync", {
      groupName: `chalk-${environment}-direct-sync`,
      description: "Inbound 443 for the direct Sync path",
      vpcId: subnet.vpcId,
      tags: { Name: `chalk-${environment}-direct-sync`, "chalk:environment": environment },
      ingress: [],
      egress: [],
    });
    yield* AWS.EC2.SecurityGroupRule("HttpsIpv4", { group, type: "ingress", description: "Direct Sync TLS", ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIpv4: "0.0.0.0/0" });
    if (config.ipv6Address !== undefined) yield* AWS.EC2.SecurityGroupRule("HttpsIpv6", { group, type: "ingress", description: "Direct Sync TLS", ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIpv6: "::/0" });
    yield* NetworkInterfaceSecurityGroup("HostAttachment", { networkInterfaceId: primary.NetworkInterfaceId, securityGroupId: group.groupId, environment });
    yield* Cloudflare.DNS.Record("Ipv4", { zoneId: config.zoneId, name: config.hostname, type: "A", content: config.ipv4Address, ttl: 60, proxied: false, comment: `chalk direct sync (${environment})` });
    if (config.ipv6Address !== undefined) yield* Cloudflare.DNS.Record("Ipv6", { zoneId: config.zoneId, name: config.hostname, type: "AAAA", content: config.ipv6Address, ttl: 60, proxied: false, comment: `chalk direct sync (${environment})` });
    return { security_group_id: group.groupId, direct_sync_url: `wss://${config.hostname}/v1/sync` };
  }).pipe(Effect.orDie),
);
