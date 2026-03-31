# iOS Production Readiness Session Log

## 2026-03-31 12:01:47 PKT
- Started iOS production-readiness / App Store Connect metadata prep for Chalk mobile.
- Loaded project AGENTS guidance and mobile release skill context.
- Gathered current app metadata from repo: Chalk iOS version 0.0.16 (build 16), bundle id ai.q9labs.chalk.mobile, privacy URL draft https://chalkmeet.com/privacy/.
- Pulled reviewer notes and store-review helper drafts from apps/mobile/STORE_REVIEW_HELPER.md.
- Began checking latest Apple submission requirements and screenshot rules from official Apple docs.

## 2026-03-31 12:04:00 PKT
- Confirmed from Apple App Store Connect help that the current required platform-version fields include screenshots, description, keywords, support URL, and app review contact/notes.
- Confirmed Apple guidance that Support URL should point to actual contact information, not just a marketing homepage.
- Verified public routes:
  - https://chalkmeet.com/privacy/ returns 200 and contains privacy contact info.
  - https://chalkmeet.com/terms/ redirects then resolves and contains support@chalk.com.
- Attempted browser automation attach to Helium via CDP on localhost:9222.
- Attach is currently blocked because the running Helium instance is not exposing a remote debugging port.
- Created scratchpad/ios-app-store-connect-draft-2026-03-31.md with ready-to-paste App Store metadata, screenshot plan, and review notes.
## 2026-03-31 12:08:30 PKT
- User approved relaunching a CDP-enabled Helium window for direct App Store Connect automation.
- Started Helium on localhost:9222 using isolated profile ~/Library/Application Support/net.imput.helium-cdp.
- Initial attach reached Apple login page because the CDP profile was not authenticated.
- Verified the normal Helium profile contains Apple/App Store Connect cookies and began cloning relevant browser state into the CDP profile.

