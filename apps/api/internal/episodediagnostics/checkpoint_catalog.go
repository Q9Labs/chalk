package episodediagnostics

// checkpointCatalogEntry mirrors ActionCheckpointContract in the shared
// diagnostics contract. Keep entries ordered: display order is part of the
// debugger's stable operation shape and drives last-confirmed/missing fields.

// checkpointCatalog returns the exact semantic family for every operation in
// ActionOperationKeys. The shared TypeScript catalog uses the same families;
// the parity test loads its generated semantic fixture and checks every catalogued
// operation, so a newly-added action cannot silently fall back to intent and
// terminal checkpoints.

// Event extras and future unknown names are still rendered safely. All
// closed v1 actions above take a semantic family before this fallback.
