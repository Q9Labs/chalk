The portrait is the MediaPipe `portrait.jpg` test input from
https://storage.googleapis.com/mediapipe-assets/portrait.jpg, used with the
Apache-2.0 MediaPipe image-segmentation tests. It is used only by the browser proof.

The hashed AVIF and WebP files mirror Chalk's existing generated background set
at https://assets.chalkmeet.com/ui/backgrounds/. Browser tests intercept those
requests to run offline. These fixtures are not imported by the production app.
