// Rotation returns the revision required by PATCH without a webhooks:read scope.
export async function rotateAndPatchEndpoint(call, path, body) {
  const rotated = await call("POST", `${path}/rotate-secret`, { revoke_previous_immediately: true });
  const endpoint = await call("PATCH", path, body, { "If-Match": `"${rotated.revision}"` });
  return { ...endpoint, secret: rotated.secret };
}
