# Chalk Android Store Listing Checklist

Last updated: 2026-03-22

This is repo-grounded only. Anything not found in the tree is marked missing.

## Current app facts from repo

- App name: `Chalk`
- Android package: `ai.q9labs.chalk.mobile`
- Current version in app config: `0.0.10`
- Current Android versionCode: `10`
- Public app site: `https://chalk.q9labs.ai`
- Privacy policy route: `https://chalk.q9labs.ai/privacy/`
- Privacy policy backup route: `https://chalk.q9labs.ai/privacy-policy/`

## Required Play listing pieces

### App icon

- Status: present
- Source asset: `apps/mobile/assets/icon.png`
- Repo check: PNG, `512 x 512`
- Play requirement: 32-bit PNG with alpha, `512 x 512`, max `1024KB`
- Notes: this is the mobile icon source already wired into `apps/mobile/app.config.ts`

### Feature graphic

- Status: missing from repo
- Required Play spec: JPEG or 24-bit PNG, no alpha, `1024 x 500`
- Repo search result: no dedicated feature graphic file found under `apps/mobile`, `apps/web/public`, or `docs`

### Screenshots

- Status: missing from repo
- Required Play spec: at least 2 screenshots across device types to publish
- Play recommendation for app promotion surfaces: at least 4 app screenshots, `1080px+`, with portrait `9:16` or landscape `16:9`
- Repo search result: no Play screenshot pack found under `apps/mobile/.gplay`
- Best grounded capture targets from current app code:
  - Home screen
  - Clipboard invite suggestion state
  - Invite input / join flow
  - Created-room / in-meeting state from the actual mobile flow

### Short description

- Status: missing from repo
- Required Play spec: max `80` characters
- Repo search result: no store short description text found

### Full description

- Status: missing from repo
- Required Play spec: max `4000` characters
- Repo search result: no store full description text found

### Contact

- Status: partially present in repo, but not yet consolidated for Play
- Play requirement: an email address is required to publish or update apps on Google Play
- Repo-found contact candidates:
  - `support@chalk.com` from `apps/web/src/routes/terms.tsx`
  - `privacy@chalk.com` from `apps/web/src/routes/privacy.tsx`
- Grounded note: use one real team-owned email for Play developer contact; the repo does not prove which one is the final store contact

### Privacy policy

- Status: present
- Primary URL from repo helper: `https://chalk.q9labs.ai/privacy/`
- Backup URL from repo helper: `https://chalk.q9labs.ai/privacy-policy/`
- Static backup file: `apps/web/public/privacy-policy/index.html`
- Policy content route: `apps/web/src/routes/privacy.tsx`

## What to upload for internal/public rollout

- App icon: yes, already in tree
- Feature graphic: still needs to be created
- Screenshots: still need to be captured/exported
- Short description: still needs to be written
- Full description: still needs to be written
- Contact email: still needs final selection
- Privacy policy URL: yes, already available

## Practical next step

- Create `apps/mobile/.gplay/listings/` with the store text and asset files once the final contact email and copy are approved.
- Capture screenshots from the real mobile app flow after the signed build is installed.
