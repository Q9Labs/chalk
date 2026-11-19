# Checked infrastructure releases

`plan-view.ts` projects a complete, known desired-property plan, using only
stable upstream attributes. It rejects actions, binding mutations, incomplete
state and unresolved proposed values before policy checking. `policy.ts`
compares that projection to explicit resource types, exact property patches,
permitted outputs and permitted inputs. It rejects creates, replacements,
deletes, adoption, duplicate/partial/unexpected resource sets, changed no-op
props, unrelated outputs, and mismatched or unrelated requested inputs.

`apply.ts` is the policy-checked apply boundary: it applies exactly the same
in-memory Alchemist plan, or does not apply. `driver.ts` owns the dispatcher
lease, live-drift precheck and post-apply convergence check. The dispatcher's
policies are declared beside the stack, not in Python. Python retains artifact
copying/readback and read-only state pin retention; it calls one operation and
reads one private JSON result. There is no stdin approval protocol.

`deploy.ts` is the generic CLI deploy path for registered cut-over stacks. It
checks actual seeded resource/output state before apply, in addition to the
registry's cutover status. Ephemeral bootstrap additionally requires the exact expected create-only dispatcher graph. Normal production releases always use the narrower declared policy.

## Python policy parity

The old tests in `scripts/recorder/test_dispatcher_alchemy.py` are preserved as
TypeScript tests over real dispatcher input/resource-property fixtures. The
three state pin-retention tests remain in Python because retention intentionally
needs only AWS CLI and must not require Node, stack evaluation or a lease.

| Previous Python test | Current proof in `../transcription-dispatcher/policy.test.ts` |
| --- | --- |
| `test_complete_noop_is_safe` | `complete_noop_is_safe` |
| `test_rejects_dangerous_actions_even_for_allowlisted_resources` | `rejects_dangerous_actions_even_for_allowlisted_resources` |
| `test_rejects_partial_plan_and_resource_type_swap` | `rejects_partial_plan_and_resource_type_swap` |
| `test_binding_changes_only_release_identity` | `binding_changes_only_release_identity` |
| `test_media_release_changes_only_exact_artifact_and_metadata` | `media_release_changes_only_exact_artifact_and_metadata` |
| `test_mai_does_not_expand_other_permissions_or_change_code` | `mai_does_not_expand_other_permissions_or_change_code` |
| `test_unrelated_outputs_and_noop_prop_changes_are_rejected` | `unrelated_outputs_and_noop_prop_changes_are_rejected` |

Additional tests cover exact requested-input matching, inactive input changes,
MAI removal (including the KMS context), unseeded outputs, unknown desired props,
and rejection before apply. `apply.test.ts` uses the real Alchemist engine and
in-memory state: changing the declaration after planning cannot replace the
checked plan, and an invalid policy cannot invoke apply. Per-run fixtures disable their schedule; legacy Nightly is retired and has no steady-state schedule.

The policy does not excuse infrastructure changes: the media release path still
requires its supported configuration fingerprint to match. Updating that pin
requires a separate declaration/no-op proof, not weakening the property policy.
