export const fixture = {};

export async function launchGuests(run) {
  run.resources.push({ dispose: fixture.dispose });
  return { pages: [{ evaluate: fixture.leave }] };
}

export function stats() {
  return [];
}
