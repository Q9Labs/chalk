# Chalk mobile release contract

The mobile app uses Chalk's public API and native SpaceClient defaults. It does
not embed an API key, Guest credential, invite token, or local development
bridge in an Expo variable.

Production builds set `CHALK_APP_VARIANT=production` through the release wrapper.
All credentials are returned by the public invite API at runtime and are kept in
the device secure store only for the lifetime of an active arrival.
