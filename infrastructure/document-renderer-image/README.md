# Document renderer image

This stack deploys the container-image variant of the presenting document renderer next to the ZIP renderer. It is the same
stack code with the `image` variant (`rendererStack`), and its entrypoint is `infrastructure/document-renderer-image/alchemy.run.ts`.
Configuration, release safety, the image build and the ECR repository are described in [the document renderer README](../document-renderer/README.md).
