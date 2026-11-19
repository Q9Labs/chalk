import assert from "node:assert/strict";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { parseConfig } from "./config.ts";
import { canonicalBucketProps, kmsPolicy, poolFirewallProps } from "./resources.ts";
import { firewallProps, tofuFirewall } from "../migration/sfu.ts";

test("recorder defaults remain zero-idle and do not authorize mutations", () => {
  const config = parseConfig({});
  assert.equal(config.enable_apply, false);
  assert.equal(config.desired_capture_nodes, 0);
  assert.equal(config.desired_render_nodes, 0);
  assert.equal(config.global_recorder_compute_nodes, 0);
});

test("capture demand includes the free-slot floor and the largest qualified constraint", () => {
  const config = parseConfig({ reserved_capture_episodes: 3, ready_spare: 1, reserved_capture_participants: 100, reserved_capture_input_mbps: 40 });
  assert.equal(config.desired_capture_nodes, 4);
  assert.throws(() => parseConfig({ reserved_capture_episodes: 10, ready_spare: 1 }), /exceeds capture_max_nodes/);
  assert.throws(() => parseConfig({ reserved_capture_participants: 101 }), /launch ceiling/);
  assert.throws(() => parseConfig({ render_desired_nodes: 1 }), /external reconciliation/);
});

test("production and mutations fail closed without their existing evidence contracts", () => {
  assert.throws(() => parseConfig({ environment: "production" }), /explicit existing R2 inventory/);
  assert.throws(() => parseConfig({ enable_apply: true }), /requires evidence/);
  assert.throws(() => parseConfig({ control_addresses: ["192.0.2.0/24"] }), /individual IPv4/);
  assert.throws(() => parseConfig({ capture_provider_token: "not-a-real-token" }), /embedded credentials/);
  assert.throws(() => parseConfig({ reserved_capture_meetings: 1 }), /unknown fields/);
});

test("recorder firewalls stay unattached and outbound-only, including SFU media port 1473", () => {
  const config = parseConfig({ control_addresses: ["192.0.2.1/32"] });
  const roles: ("capture" | "render")[] = ["capture", "render"];
  for (const role of roles) {
    const firewall = poolFirewallProps(config, role);
    assert.deepEqual(firewall.inboundRules, []);
    assert.deepEqual(firewall.dropletIds, []);
    assert.equal(
      firewall.outboundRules?.some((rule) => rule.protocol === "udp" && rule.ports === "1473"),
      role === "capture",
    );
  }
});

test("legacy KMS context permits decryption only and retains all authenticated canonical keys", () => {
  const policySchema = Schema.fromJsonString(Schema.Struct({ Statement: Schema.Array(Schema.Struct({ Sid: Schema.String, Action: Schema.Array(Schema.String), Condition: Schema.optional(Schema.Struct({ Null: Schema.optional(Schema.Record(Schema.String, Schema.String)) })) })) }));
  const policy = Schema.decodeUnknownSync(policySchema)(kmsPolicy({ environment: "nightly", control_plane_role_arn: "arn:aws:iam::000000000000:role/example", legacy_kms_context_key: "chalk.legacy_episode" }, "000000000000"));
  const legacy = policy.Statement.find((statement) => statement.Sid === "ControlPlaneDecryptLegacyRecordingCiphertext");
  assert.deepEqual(legacy?.Action, ["kms:Decrypt", "kms:DescribeKey"]);
  const canonical = policy.Statement.find((statement) => statement.Sid === "ControlPlaneGenerateAndDecryptRecordingKeys");
  assert.equal(Object.keys(canonical?.Condition?.Null ?? {}).length, 8);
  assert.equal(canonical?.Condition?.Null?.["kms:EncryptionContext:chalk.capture_epoch"], "false");
  assert.equal(canonical?.Condition?.Null?.["kms:EncryptionContext:chalk.envelope_digest"], "false");
});

test("state import rejects firewall selectors it cannot preserve", () => {
  const firewall = { id: "example", name: "example", droplet_ids: [], tags: [], inbound_rule: [], outbound_rule: [{ protocol: "tcp", port_range: "443", destination_tags: ["not-an-address-rule"] }] };
  assert.throws(() => Schema.decodeUnknownSync(tofuFirewall)(firewall));
});

test("state import accepts legacy null ICMP ports but never unspecified TCP ports", () => {
  const fixture = (protocol: string) => ({ id: "example", name: "example", droplet_ids: [], tags: null, inbound_rule: [{ protocol, port_range: null, source_addresses: ["192.0.2.1/32"] }], outbound_rule: [] });
  const icmp = Schema.decodeUnknownSync(tofuFirewall)(fixture("icmp"));
  assert.equal(firewallProps(icmp).inboundRules?.[0]?.ports, "0");
  const tcp = Schema.decodeUnknownSync(tofuFirewall)(fixture("tcp"));
  assert.throws(() => firewallProps(tcp), /Invalid firewall port range/);
});

test("imported R2 policy sets and definitions compare identically without hiding policy changes", () => {
  const left = { cors: [{ id: "whiteboard", allowedMethods: ["GET", "PUT"], allowedOrigins: ["*"], allowedHeaders: ["If-None-Match", "Content-Type"] }], lifecycleRules: [{ id: "temporary" }, { id: "abort" }] } satisfies Parameters<typeof canonicalBucketProps>[0];
  const right = { cors: [{ id: "whiteboard", allowedMethods: ["PUT", "GET"], allowedOrigins: ["*"], allowedHeaders: ["Content-Type", "If-None-Match"] }], lifecycleRules: [{ id: "abort" }, { id: "temporary" }] } satisfies Parameters<typeof canonicalBucketProps>[0];
  assert.deepEqual(canonicalBucketProps(left), canonicalBucketProps(right));
  assert.notDeepEqual(canonicalBucketProps(left), canonicalBucketProps({ ...right, cors: right.cors.map((rule) => ({ ...rule, allowedOrigins: ["https://example.com"] })) }));
});
