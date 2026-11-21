import { createEntrySender, mintEntryIds, type EntrySender, type EntrySenderOptions } from "@q9labsai/chalk-client";

/**
 * The React package's channel to the entry path: the host app configures it once with the API base it
 * is joining, and prejoin/admission records then flow through C3's credential-free ENTRY_PATH. With no
 * channel configured the package reports nothing — entry records never block rendering.
 */
let channel: EntrySender | undefined;

export function configureEntrySender(options: Omit<EntrySenderOptions, "cs" | "dev" | "ephemeral">): EntrySender {
  const ids = mintEntryIds();
  channel = createEntrySender({ ...options, cs: ids.cs, dev: ids.dev, ephemeral: ids.ephemeral });
  return channel;
}

export function setEntrySender(sender: EntrySender): void {
  channel = sender;
}

export function entryChannel(): EntrySender | undefined {
  return channel;
}

export function entryFact(name: string, fields: Record<string, unknown> = {}): void {
  channel?.fact(name, fields);
}

export function entryTransition(machine: string, from: string, to: string, trigger: string, fields: Record<string, unknown> = {}): void {
  channel?.transition(machine, from, to, trigger, fields);
}
