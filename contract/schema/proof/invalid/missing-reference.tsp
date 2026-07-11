import "../../../../tools/contract-codegen/src/typespec-proof/main.tsp";

namespace Chalk.ContractProof.Invalid;

model MissingReference {
  roomId: MissingRoomId;
}
