import assert from "node:assert/strict";
import { test } from "node:test";
import type * as DigitalOcean from "@alchemy.run/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { keepRecordedPowerStatus } from "./digitalocean-sfu-droplet.ts";

const droplet = (status: DigitalOcean.DropletAttributes["status"]): DigitalOcean.DropletAttributes => ({
  dropletId: 1,
  urn: "do:droplet:1",
  name: "chalk-sfu-production-standby",
  status,
  region: "sgp1",
  sizeSlug: "s-1vcpu-1gb",
  imageId: 1,
  imageSlug: "ubuntu-24-04-x64",
  ipv4: undefined,
  privateIpv4: undefined,
  ipv6: undefined,
  vpcUuid: undefined,
  features: ["monitoring"],
  tags: ["chalk-sfu"],
  createdAt: "2026-01-01T00:00:00Z",
});

test("a live power status difference keeps the recorded status, so drift stays quiet", () => {
  const live = droplet("active");
  const kept = keepRecordedPowerStatus(live, "off");
  assert.equal(kept?.status, "off");
  assert.equal(live.status, "active");
  assert.equal(kept?.dropletId, live.dropletId);
});

test("an unchanged or missing power status is left alone", () => {
  const live = droplet("active");
  assert.equal(keepRecordedPowerStatus(live, "active"), live);
  assert.equal(keepRecordedPowerStatus(live, undefined), live);
  assert.equal(keepRecordedPowerStatus(undefined, "off"), undefined);
});

test("keeping the recorded power status preserves an ownership refusal", () => {
  const foreign = Unowned(droplet("active"));
  const kept = keepRecordedPowerStatus(foreign, "off");
  assert.equal(kept?.status, "off");
  assert.equal(Unowned.is(kept), true);
});
