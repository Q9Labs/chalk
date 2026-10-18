# Observed SendCommand validation failure

`ssm-comment-validation.json` retains the AWS `ValidationException` from nightly Release [39117223384](https://github.com/Q9Labs/chalk/actions/runs/39117223384), source `99fe4ecd584b3b2bbb75862503d708b87c8e976e`, on 18 October 2026. It failed before any host command was accepted.

The release ID, request ID, rejected comment and error text were extracted from that run's failed-step log, not invented. They contain only public run/release identities; no account IDs, instance IDs, ARNs or secrets are included. The provider error states the 100-character limit. Tests replay these observed inputs through the public deploy entry point, then also exercise maximum-length accepted identities in nightly and production.
