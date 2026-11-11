/** Turn off the public invite of a Space the proof reused. An Episode's end does not touch it, so an old link would still enter the Space. */
export async function closeReusedInvite(run, space) {
  await run.ownerRequest("PATCH", `${run.tenantPath}/spaces/${space.id}/public-invite`, { enabled: false });
}
