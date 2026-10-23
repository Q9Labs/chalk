export const fixture = {};

export async function launchGuests(run) {
  run.resources.push({ dispose: fixture.dispose });
  return { pages: [{ evaluate: async (action) => action() }] };
}

export function stats() {
  return [];
}
