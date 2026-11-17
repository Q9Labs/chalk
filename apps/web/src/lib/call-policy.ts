/** The length policy of a call a signed-in person starts, wherever they start it: the default, the longest, and the wait after the last person leaves. */
export const ACCOUNT_CALL_POLICY = { default_episode_duration_seconds: 3600, maximum_episode_duration_seconds: 86400, linger_window_seconds: 60 } as const;

/** The longest a call anyone can start without an account may run. It matches the API's anonymous policy. */
const ANONYMOUS_CALL_MAXIMUM_SECONDS = 3600;

/** Whether signing up would give this call's host a longer call than the Space allows. */
export function accountWouldAllowLonger(spaceMaximumSeconds: number | undefined): boolean {
  return (spaceMaximumSeconds ?? ANONYMOUS_CALL_MAXIMUM_SECONDS) < ACCOUNT_CALL_POLICY.maximum_episode_duration_seconds;
}

/** The sign-up offer shown at the call limit, naming what an account allows. */
export function signUpOffer(): string {
  return `Sign up free for calls up to ${ACCOUNT_CALL_POLICY.maximum_episode_duration_seconds / 3600} hours.`;
}
