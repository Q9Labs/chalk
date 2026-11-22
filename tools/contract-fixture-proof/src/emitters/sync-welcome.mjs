/** @param {Record<string, any>} contract */
export function welcomeFlagsFor(contract) {
  return Object.values(contract.welcome)
    .filter((field) => field?.optional && field.value === true)
    .map((field) => field.wireName);
}

/** @param {Record<string, any>} contract */
export function renderWelcomeSchemas(contract) {
  const flags = welcomeFlagsFor(contract)
    .map((name) => `${name}: Schema.optionalKey(Schema.Literal(true))`)
    .join(", ");
  const lines = [];
  lines.push(
    `const WelcomeBase = { type: Schema.Literal('welcome'), protocol: Schema.Literal(${contract.protocol.value}), participant_id: UuidSchema, participant_generation: PositiveIntegerSchema, participant_identity_id: Schema.optionalKey(UuidSchema), recovery_id: UuidSchema, head: ControlCursorSchema, ${flags}, entry_generation: Schema.optionalKey(PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(${contract.welcome.entryGeneration.maximum}))) };`,
  );
  lines.push("const ExtendedWelcomeBase = { ...WelcomeBase, extensions: Schema.Tuple([CollaborationWelcomeExtensionSchema]) };");
  lines.push("export const WelcomeSnapshotFrameSchema = Schema.Struct({ ...WelcomeBase, mode: Schema.Literal('snapshot'), snapshot: SnapshotSchema, ...ServerCorrelationFields }).check(boundedServerFrame(SyncProtocolLimits.snapshotEncodedBytes));");
  lines.push("export const WelcomeReplayFrameSchema = Schema.Struct({ ...WelcomeBase, mode: Schema.Literal('replay'), ...ServerCorrelationFields });");
  lines.push("export const WelcomeUpToDateFrameSchema = Schema.Struct({ ...WelcomeBase, mode: Schema.Literal('up_to_date'), ...ServerCorrelationFields });");
  lines.push("export const WelcomeTerminalFrameSchema = Schema.Struct({ ...WelcomeBase, mode: Schema.Literal('terminal'), reason: TerminalRecoveryReasonSchema, ...ServerCorrelationFields });");
  lines.push("export const ExtendedWelcomeSnapshotFrameSchema = Schema.Struct({ ...ExtendedWelcomeBase, mode: Schema.Literal('snapshot'), snapshot: SnapshotSchema, ...ServerCorrelationFields }).check(boundedServerFrame(SyncProtocolLimits.snapshotEncodedBytes));");
  lines.push("export const ExtendedWelcomeReplayFrameSchema = Schema.Struct({ ...ExtendedWelcomeBase, mode: Schema.Literal('replay'), ...ServerCorrelationFields });");
  lines.push("export const ExtendedWelcomeUpToDateFrameSchema = Schema.Struct({ ...ExtendedWelcomeBase, mode: Schema.Literal('up_to_date'), ...ServerCorrelationFields });");
  lines.push("export const ExtendedWelcomeTerminalFrameSchema = Schema.Struct({ ...ExtendedWelcomeBase, mode: Schema.Literal('terminal'), reason: TerminalRecoveryReasonSchema, ...ServerCorrelationFields });");
  lines.push(
    "export const WelcomeFrameSchema = Schema.Union([ExtendedWelcomeSnapshotFrameSchema, ExtendedWelcomeReplayFrameSchema, ExtendedWelcomeUpToDateFrameSchema, ExtendedWelcomeTerminalFrameSchema, WelcomeSnapshotFrameSchema, WelcomeReplayFrameSchema, WelcomeUpToDateFrameSchema, WelcomeTerminalFrameSchema]);",
  );
  return lines;
}
