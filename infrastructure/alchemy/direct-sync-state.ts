import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as Provider from "alchemy/Provider";
import { deepEqual } from "alchemy/Diff";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NetworkInterfaceSecurityGroup, readInterface, readInterfaceGroup } from "./network-interface-security-group.ts";
import { seedResource } from "./seed-resource.ts";

interface SourceResource {
  mode: string;
  type: string;
  name: string;
  module?: string | undefined;
  instances: readonly { attributes: unknown; deposed?: string | undefined }[];
}

export function validateDirectSyncResourceSet(resources: readonly SourceResource[]) {
  const managed = resources.filter((resource) => resource.mode === "managed");
  const required = ["aws_security_group.direct_sync", "aws_vpc_security_group_ingress_rule.https_ipv4", "aws_network_interface_sg_attachment.direct_sync", "cloudflare_dns_record.ipv4"];
  const optional = ["aws_vpc_security_group_ingress_rule.https_ipv6", "cloudflare_dns_record.ipv6"];
  if (
    managed.some((resource) => resource.module || ![...required, ...optional].includes(`${resource.type}.${resource.name}`)) ||
    new Set(managed.map((resource) => `${resource.type}.${resource.name}`)).size !== managed.length ||
    required.some((address) => !managed.some((resource) => `${resource.type}.${resource.name}` === address))
  )
    throw new Error("Unexpected direct-sync resource set; refusing partial migration.");
  return managed;
}

type Get = <A>(type: string, name: string, schema: Schema.Codec<A>) => A;

const sourceGetter = (managed: readonly SourceResource[]): Get => {
  return <A>(type: string, name: string, schema: Schema.Codec<A>): A => {
    const resource = managed.find((resource) => resource.type === type && resource.name === name);
    const instance = resource?.instances[0];
    if (resource?.instances.length !== 1 || !instance || instance.deposed) throw new Error(`Expected one current ${type}.${name}; refusing to seed.`);
    try {
      return Schema.decodeUnknownSync(schema)(instance.attributes);
    } catch {
      throw new Error(`Invalid ${type}.${name}; state contents are not printed.`);
    }
  };
};

const liveAttachment = Effect.fn(function* (attachment: { network_interface_id: string; security_group_id: string }, resources: readonly SourceResource[]) {
  // Check the interface first: stale state must never claim a replacement host.
  const attached = yield* readInterfaceGroup(attachment.network_interface_id, attachment.security_group_id);
  if (!attached) return yield* Effect.die("The saved direct-sync interface or group attachment no longer exists; refusing to seed stale state.");
  const networkInterface = yield* readInterface(attachment.network_interface_id);
  const hostId = networkInterface?.Attachment?.InstanceId;
  const savedHost = resources.filter((resource) => resource.mode === "data" && resource.type === "aws_instance" && resource.name === "host");
  if (!hostId || savedHost.length !== 1 || savedHost[0]?.instances.length !== 1 || Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(savedHost[0].instances[0]?.attributes).id !== hostId) return yield* Effect.die("Saved interface is not attached to the saved direct-sync host.");
  const host = (yield* ec2.describeInstances({ InstanceIds: [hostId] })).Reservations?.flatMap((reservation) => reservation.Instances ?? [])[0];
  if (!host?.Tags?.some((tag) => tag.Key === "chalk:environment" && tag.Value === "nightly")) return yield* Effect.die("The saved host is not tagged for Nightly.");
  return attached;
});

const liveGroup = Effect.fn(function* (sg: { id: `sg-${string}`; name: string; description: string; vpc_id: string; tags: Readonly<Record<string, string>> }) {
  const groupProvider = yield* Provider.findProvider(AWS.EC2.SecurityGroup);
  if (!groupProvider.lookup) return yield* Effect.die("Missing security group lookup.");
  const group = yield* groupProvider.lookup({ groupId: sg.id });
  if (!group || group.groupName !== sg.name || group.description !== sg.description || group.vpcId !== sg.vpc_id || Object.entries(sg.tags).some(([key, value]) => group.tags?.[key] !== value) || (group.egressRules?.length ?? 0))
    return yield* Effect.die("Live security group differs from saved direct-sync configuration.");
  return group;
});

const ruleRow = Effect.fn(function* (get: Get, family: string, groupId: `sg-${string}`) {
  const rule = get(
    "aws_vpc_security_group_ingress_rule",
    `https_${family}`,
    Schema.Struct({
      id: Schema.TemplateLiteral(["sgr-", Schema.String]),
      security_group_id: Schema.TemplateLiteral(["sg-", Schema.String]),
      ip_protocol: Schema.Literal("tcp"),
      from_port: Schema.Literal(443),
      to_port: Schema.Literal(443),
      description: Schema.Literal("Direct Sync TLS"),
      cidr_ipv4: Schema.NullOr(Schema.String),
      cidr_ipv6: Schema.NullOr(Schema.String),
    }),
  );
  if (rule.security_group_id !== groupId || (family === "ipv4" ? rule.cidr_ipv4 !== "0.0.0.0/0" || rule.cidr_ipv6 !== null : rule.cidr_ipv6 !== "::/0" || rule.cidr_ipv4 !== null)) return yield* Effect.die("Unexpected direct-sync ingress rule.");
  const observed = (yield* ec2.describeSecurityGroupRules({ SecurityGroupRuleIds: [rule.id] })).SecurityGroupRules?.[0];
  if (!observed?.GroupOwnerId) return yield* Effect.die("Existing direct-sync rule was not found.");
  if (
    !deepEqual(
      [observed.GroupId, observed.IsEgress, observed.IpProtocol, observed.FromPort, observed.ToPort, observed.Description, observed.CidrIpv4 ?? null, observed.CidrIpv6 ?? null],
      [groupId, false, rule.ip_protocol, rule.from_port, rule.to_port, rule.description, rule.cidr_ipv4, rule.cidr_ipv6],
    )
  )
    return yield* Effect.die("Live direct-sync rule differs from saved state.");
  const props = {
    group: { groupId: groupId },
    type: "ingress",
    ipProtocol: rule.ip_protocol,
    fromPort: rule.from_port,
    toPort: rule.to_port,
    description: rule.description,
    ...(rule.cidr_ipv4 ? { cidrIpv4: rule.cidr_ipv4 } : {}),
    ...(rule.cidr_ipv6 ? { cidrIpv6: rule.cidr_ipv6 } : {}),
  } satisfies AWS.EC2.SecurityGroupRule["Props"];
  return seedResource(
    AWS.EC2.SecurityGroupRule.Type,
    family === "ipv4" ? "HttpsIpv4" : "HttpsIpv6",
    rule.id,
    props,
    {
      securityGroupRuleId: rule.id,
      groupId: groupId,
      groupOwnerId: observed.GroupOwnerId,
      isEgress: false,
      ipProtocol: rule.ip_protocol,
      fromPort: rule.from_port,
      toPort: rule.to_port,
      description: rule.description,
      cidrIpv4: observed.CidrIpv4,
      cidrIpv6: observed.CidrIpv6,
    } satisfies AWS.EC2.SecurityGroupRule["Attributes"],
    [],
  );
});

const dnsRow = Effect.fn(function* (get: Get, family: string) {
  const record = get(
    "cloudflare_dns_record",
    family,
    Schema.Struct({ id: Schema.String, zone_id: Schema.String, name: Schema.String, type: Schema.Literals(["A", "AAAA"]), content: Schema.String, ttl: Schema.Literal(60), proxied: Schema.Literal(false), comment: Schema.Literal("chalk direct sync (nightly)") }),
  );
  if (record.type !== (family === "ipv4" ? "A" : "AAAA")) return yield* Effect.die("Unexpected direct-sync DNS family.");
  const live = yield* dns.getRecord({ zoneId: record.zone_id, dnsRecordId: record.id });
  if (live.id !== record.id || live.name !== record.name || live.type !== record.type || live.content !== record.content || live.ttl !== record.ttl || live.proxied !== record.proxied || live.comment !== record.comment) return yield* Effect.die("Live direct-sync DNS differs from saved state.");
  return seedResource(
    Cloudflare.DNS.Record.Type,
    family === "ipv4" ? "Ipv4" : "Ipv6",
    record.id,
    { zoneId: record.zone_id, name: record.name, type: record.type, content: record.content, ttl: record.ttl, proxied: record.proxied, comment: record.comment } satisfies Cloudflare.DNS.Record["Props"],
    { recordId: record.id, zoneId: record.zone_id, name: record.name, type: record.type, content: record.content, ttl: record.ttl, proxied: record.proxied, createdOn: live.createdOn ?? undefined, modifiedOn: live.modifiedOn ?? undefined } satisfies Cloudflare.DNS.Record["Attributes"],
    [],
  );
});

export const directSyncRows = Effect.fn(function* (resources: readonly SourceResource[]) {
  const managed = validateDirectSyncResourceSet(resources);
  const get = sourceGetter(managed);
  const hasIpv6 = managed.some((resource) => resource.type === "cloudflare_dns_record" && resource.name === "ipv6" && resource.instances.length > 0);
  if (managed.some((resource) => resource.type === "aws_vpc_security_group_ingress_rule" && resource.name === "https_ipv6" && resource.instances.length > 0) !== hasIpv6) return yield* Effect.die("IPv6 DNS and ingress rule must be present together.");
  const sg = get("aws_security_group", "direct_sync", Schema.Struct({ id: Schema.TemplateLiteral(["sg-", Schema.String]), name: Schema.String, description: Schema.String, vpc_id: Schema.String, tags: Schema.Record(Schema.String, Schema.String) }));
  const attachment = get("aws_network_interface_sg_attachment", "direct_sync", Schema.Struct({ id: Schema.String, security_group_id: Schema.String, network_interface_id: Schema.String }));
  if (attachment.security_group_id !== sg.id || sg.name !== "chalk-nightly-direct-sync" || sg.description !== "Inbound 443 for the direct Sync path" || sg.tags["chalk:environment"] !== "nightly" || sg.tags.Name !== sg.name)
    return yield* Effect.die("Unexpected direct-sync group or attachment configuration.");
  const attached = yield* liveAttachment(attachment, resources);
  const group = yield* liveGroup(sg);
  const rows: CreatedResourceState[] = [];
  const ruleIds: string[] = [];
  for (const family of hasIpv6 ? ["ipv4", "ipv6"] : ["ipv4"]) {
    const rule = yield* ruleRow(get, family, sg.id);
    ruleIds.push(rule.instanceId);
    rows.push(rule, yield* dnsRow(get, family));
  }
  if ((group.ingressRules?.length ?? 0) !== ruleIds.length || (group.ingressRules ?? []).some((rule) => !ruleIds.includes(rule.securityGroupRuleId))) return yield* Effect.die("Unexpected live rules on the direct-sync security group.");
  rows.unshift(
    seedResource(AWS.EC2.SecurityGroup.Type, "DirectSync", sg.id, { groupName: sg.name, description: sg.description, vpcId: group.vpcId, tags: sg.tags, ingress: [], egress: [] } satisfies AWS.EC2.SecurityGroup["Props"], { ...group, ingressRules: [], egressRules: [] }, [
      "HttpsIpv4",
      ...(hasIpv6 ? ["HttpsIpv6"] : []),
      "HostAttachment",
    ]),
  );
  rows.push(seedResource(NetworkInterfaceSecurityGroup.Type, "HostAttachment", attachment.id, { networkInterfaceId: attachment.network_interface_id, securityGroupId: attachment.security_group_id, environment: "nightly" } satisfies NetworkInterfaceSecurityGroup["Props"], attached, []));
  return rows;
});
