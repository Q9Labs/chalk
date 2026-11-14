# A change under these paths can change the mobile app. Everything else is web, API, sync or docs only.
# The nightly iOS and Android jobs source this file, so they skip a build for the same reason.
nightly_app_paths=(apps/mobile packages sdks/typescript/client sdks/typescript/react-native release/manifest.json pnpm-lock.yaml .tool-versions)
