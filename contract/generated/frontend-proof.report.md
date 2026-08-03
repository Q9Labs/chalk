# Chalk frontend contract proof

Both frontends lower the same representative Chalk fixture to byte-identical canonical ContractIR. This establishes fixture parity. It does not establish semantic equivalence for every valid or invalid contract.

## Hard gates

| Gate | Result |
| --- | --- |
| Representative fixture assertions | PASS |
| No unintended unknown types | PASS |
| Representative parser, compiler, and lowering diagnostics | PASS |
| Exact required TypeSpec dependency pins | PASS |
| Byte-identical output across 20 full frontend runs | PASS |

## Observed measurements

| Frontend | Adapter source lines | Adapter files | Required packages in transitive closure | Required package footprint (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Chalk-native JSON | 277 | 2 | 0 | 0.00 |
| TypeSpec | 670 | 5 | 70 | 20.94 |

Source-line counts exclude blank lines and lines beginning with `//`; block-comment lines remain included. The shared ContractIR validator is 689 lines by that measure and is excluded from both adapter figures. The TypeSpec footprint is the real on-disk size of only @typespec/compiler, @typespec/http, and their declared runtime dependency closure. Runtime timing is excluded because warm in-process measurements were too environment-sensitive to support a decision.

## Decision status

Inconclusive. The proof establishes deterministic fixture parity and dependency cost. Frontend selection remains blocked on cross-field semantic validation, clean source-located semantic diagnostics, and an explicit project rubric for the qualitative criteria.

Canonical SHA-256: `ddd8ad2e129c3e14576e66d867b9568f3a1643007463fa47b857c3a08064b44e`
