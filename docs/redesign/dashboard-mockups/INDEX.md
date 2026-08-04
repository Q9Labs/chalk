# Chalk dashboard mockup index

This folder preserves the dashboard design exploration in navigation order. The product is now moving into implementation; these images are references, not behavioral contracts. `docs/design.md`, `GLOSSARY.md`, and the dashboard spec remain authoritative.

## Selected direction

| File                                            | Surface              | Status                                                        |
| ----------------------------------------------- | -------------------- | ------------------------------------------------------------- |
| `00-image1-general-product-home-concept-v3.png` | General-product Home | Selected direction: collaboration studio, Developer secondary |

## Rejected calibration

| File                                    | Surface               | Status                                           |
| --------------------------------------- | --------------------- | ------------------------------------------------ |
| `00-image1-calibration-overview-v2.png` | Calibration dashboard | Rejected: too close to an administration console |

## Archived exploration

These screens are useful for coverage and flow ideas, but their visual direction is not approved for implementation.

| File                                   | Surface                      |
| -------------------------------------- | ---------------------------- |
| `01-sign-in.png`                       | Sign in                      |
| `02-sign-up.png`                       | Sign up                      |
| `03-onboarding-create-tenant.png`      | Onboarding: Tenant           |
| `04-onboarding-create-first-space.png` | Onboarding: first Space      |
| `05-onboarding-connect-app.png`        | Onboarding: Developer branch |
| `06-dashboard-overview.png`            | Dashboard overview study     |
| `07-spaces-list.png`                   | Spaces index study           |
| `08-create-space-dialog.png`           | Create Space dialog study    |
| `09-space-detail.png`                  | Space detail study           |
| `10-episodes-list.png`                 | Episodes index study         |
| `11-episode-detail.png`                | Episode detail study         |
| `12-api-keys-list.png`                 | API keys study               |
| `13-create-api-key-dialog.png`         | Create API key study         |

## Settled product decisions

- Chalk is a general collaboration product that also includes developer tooling.
- Tenant is the customer-facing boundary term.
- Browser account traffic uses a same-origin boundary.
- Core onboarding is Account → Tenant → first Space → invite or Quick join. API-key setup begins later from Developer.
