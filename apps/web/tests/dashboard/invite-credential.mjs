export function inviteCredential(raw) {
  const invite = new URL(raw);
  const code = invite.pathname.slice(1);
  return /^[a-z]+(?:-[a-z]+){2,3}$/.test(code) ? code : new URLSearchParams(invite.hash.slice(1)).get("spaceInviteToken");
}
