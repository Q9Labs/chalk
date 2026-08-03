import "../../../../tools/contract-fixture-proof/src/typespec-proof/main.tsp";

namespace Chalk.ContractProof.Invalid;

model MissingReference {
  spaceId: MissingSpaceId;
}
