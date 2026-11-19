import * as ec2 from "@distilled.cloud/aws/ec2";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export interface EipAssociation extends Resource<"Chalk.EC2.EipAssociation", { allocationId: string; instanceId: string; allowReassociation: boolean; environment: "nightly" }, { allocationId: string; associationId: string; instanceId: string }> {}
export const EipAssociation = Resource<EipAssociation>("Chalk.EC2.EipAssociation");

class InvalidAssociation extends Data.TaggedError("InvalidAssociation")<{ message: string }> {}

export const readAssociation = Effect.fn(function* (allocationId: string) {
  const result = yield* ec2.describeAddresses({ AllocationIds: [allocationId] }).pipe(Effect.catchTag("InvalidAllocationID.NotFound", () => Effect.succeed({ Addresses: [] })));
  const address = result.Addresses?.[0];
  if (!address?.AssociationId || !address.InstanceId) return undefined;
  return { allocationId, associationId: address.AssociationId, instanceId: address.InstanceId };
});

export const associationProvider = Provider.succeed(EipAssociation, {
  stables: ["allocationId"],
  list: () => Effect.succeed([]),
  read: ({ olds, output }) => (output ? readAssociation(output.allocationId) : isResolved(olds) && olds?.allocationId ? readAssociation(olds.allocationId) : Effect.undefined),
  diff: Effect.fn(function* ({ olds, news }) {
    if (isResolved(news) && olds.allocationId !== news.allocationId) return { action: "replace" };
  }),
  reconcile: Effect.fn(function* ({ news }) {
    // Drift repair bypasses the stack program, so enforce the host boundary here too.
    const instances = yield* ec2.describeInstances({ InstanceIds: [news.instanceId] });
    const instance = instances.Reservations?.flatMap((reservation) => reservation.Instances ?? [])[0];
    if (!instance?.Tags?.some((tag) => tag.Key === "chalk:environment" && tag.Value === news.environment)) {
      return yield* new InvalidAssociation({ message: "The recorder address may only be attached to a nightly host." });
    }
    const current = yield* readAssociation(news.allocationId);
    if (current?.instanceId === news.instanceId) return current;
    yield* ec2.associateAddress({
      AllocationId: news.allocationId,
      InstanceId: news.instanceId,
      AllowReassociation: news.allowReassociation,
    });
    return yield* Effect.gen(function* () {
      const attached = yield* readAssociation(news.allocationId);
      if (attached?.instanceId !== news.instanceId) {
        return yield* new InvalidAssociation({ message: "AWS did not confirm the requested EIP association." });
      }
      return attached;
    }).pipe(Effect.retry({ while: (error) => error._tag === "InvalidAssociation", schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(20)]) }));
  }),
  delete: ({ output }) => ec2.disassociateAddress({ AssociationId: output.associationId }).pipe(Effect.catchTag("InvalidAssociationID.NotFound", () => Effect.void)),
});
