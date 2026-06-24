# Chalk Teardown Session Log — 2026-06-24

Public-safe progress notes for the API/infrastructure reset.

## Intent

- Preserve the rebuild memory before deleting the old API and infrastructure code.
- Destroy current production Terraform-managed infrastructure from GitHub Actions while Terraform code still exists.
- Preserve R2 data.
- Remove old `apps/api`, `infrastructure/terraform`, `infrastructure/whisper-worker`, and `infrastructure/cloudflare-worker` code after infrastructure teardown is complete.

## Notes

- Current prod Terraform manages API EC2/EIP/security group/SSM/ECR, Cloudflare DNS/R2 config, Upstash Redis, and a PlanetScale branch role.
- R2 bucket/data is the intentional carve-out. The destroy workflow removes R2 bucket/CORS/lifecycle resources from Terraform state before `terraform destroy` so Terraform does not delete the bucket or data.
- The old Cloudflare post-meeting worker is not represented by tracked Terraform. The temporary CI workflow includes a best-effort cleanup for Cloudflare Worker scripts and Queues whose names contain `chalk`.
- Existing unrelated worktree changes at session start: deleted `scratchpad/top-level-actors.png`, untracked `.agents/skills/visual-plan/`, untracked `apps/api/cmd/_q.mjs`, untracked bundle analysis scratchpad files, and untracked `skills-lock.json`.
