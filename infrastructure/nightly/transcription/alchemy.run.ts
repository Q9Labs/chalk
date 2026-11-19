// The same stack and guarded driver serve Nightly and production. --stage selects
// the AWS state namespace; inputs come from that stage's seeded stack output.
export { default } from "../../alchemy/dispatcher/stack.ts";
