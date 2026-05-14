# Product And Integration Lessons

## Consumer Integrations

- release packages before updating consumer integrations
- verify package registry auth separately from application code
- keep consumer app changes thin and push product fixes back into Chalk
  packages
- preserve rollback paths when changing SDK versions in downstream apps

## Webhooks

Webhook behavior should be tenant-scoped, testable, and explicit about failure
delivery. Public lessons:

- verify incoming provider signatures at the boundary
- keep outgoing customer webhook payloads stable
- include recording data and explicit failure metadata when post-meeting
  processing fails
- avoid burying webhook decisions in app-specific integration code

## Design And UX

Design-system work should distinguish reusable embedded meeting UI from
first-party product shell polish. Public lessons:

- shared meeting components need neutral language and predictable controls
- app shell styling can evolve faster than SDK UI contracts
- placeholders and guard rails should use Chalk theme tokens
- browser verification complements tests for spacing, overflow, and empty-state
  behavior

## Mutation Testing And Verification

Focused mutation testing helped harden small shared utilities, especially where
visual identity or avatar behavior depends on deterministic output. Use mutation
testing selectively for compact pure logic where ordinary examples can miss
edge cases.
