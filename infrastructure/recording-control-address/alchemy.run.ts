import * as AWS from "@alchemy.run/aws";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { loadConfig } from "./config.ts";
import { nightly, providers, state } from "../platform/config.ts";
import { EipAssociation, associationProvider } from "../providers/aws-eip-association.ts";

export default Alchemy.Stack(
  "recording-control-address",
  {
    providers: Layer.merge(providers, associationProvider.pipe(Layer.provide(providers))),
    state,
  },
  Effect.gen(function* () {
    const environment = yield* nightly;
    const { instance_id: instanceId } = yield* Effect.tryPromise(loadConfig);
    const host = yield* ec2.describeInstances({ InstanceIds: [instanceId] });
    const instance = host.Reservations?.flatMap((reservation) => reservation.Instances ?? [])[0];
    if (!instance?.Tags?.some((tag) => tag.Key === "chalk:environment" && tag.Value === environment)) {
      return yield* Effect.die("The recorder address may only be attached to a nightly host.");
    }
    const address = yield* AWS.EC2.EIP("Control", {
      domain: "vpc",
      tags: { Name: "chalk-nightly-recording-control", "chalk:environment": environment },
    }).pipe(RemovalPolicy.retain());
    yield* EipAssociation("ControlAssociation", {
      allocationId: address.allocationId,
      instanceId,
      allowReassociation: true,
      environment,
    });
    return { public_ip: address.publicIp, allocation_id: address.allocationId };
  }).pipe(Effect.orDie),
);
