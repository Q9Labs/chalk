import assert from "node:assert/strict";
import { test } from "node:test";
import * as Schema from "effect/Schema";
import { firewallProps, tofuFirewall } from "./sfu.ts";

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
