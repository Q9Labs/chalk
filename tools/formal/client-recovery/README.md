# Client connection and recovery model

A TLA+ model of the SDK's connection lifecycle (`sdks/typescript/client/src/connection/lifecycle.ts`): join, a Sync or media link that drops, the recovery cycle, the access refresh, terminal frames and Leave. Every lifecycle step is one item on the actor queue, so the model keeps that queue and takes its head, with the recovery fiber and the refresh fiber beside it.

`./run.sh` checks the anchors, then every row of `runs`: the rules on the real code, and each broken variant of the code, including the three bugs the model found. It takes about a minute. See `.agents/skills/client-recovery-formal/SKILL.md` for what the model covers, the fixed findings and how to read a failure.
