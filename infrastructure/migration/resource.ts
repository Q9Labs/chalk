import type { CreatedResourceState } from "alchemy/State/ResourceState";

export const seedResource = <P extends object, A extends object>(resourceType: string, logicalId: string, instanceId: string, props: P, attr: A, downstream: string[], removalPolicy: "retain" | "destroy" = "destroy"): CreatedResourceState => ({
  status: "created",
  resourceType,
  logicalId,
  fqn: logicalId,
  instanceId,
  namespace: undefined,
  providerVersion: 0,
  props: { ...props },
  attr: { ...attr },
  bindings: [],
  downstream,
  removalPolicy,
});
