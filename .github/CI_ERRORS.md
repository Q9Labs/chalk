# CI/CD Common Errors

| Symptom | Cause | Fix |
|---------|-------|-----|
| HTTP 500 after deploy | Startup crash - missing env/config | Check container logs for panic/fatal |
| New image not running | `latest` tag doesn't trigger update | Force new deployment or use SHA tags |
| Terraform lock stuck | Crashed run | `terraform force-unlock <id>` |
| Terraform checksum mismatch | S3 ≠ DynamoDB digest | Update DynamoDB Digest field |
| API Gateway 5xx | TLS SNI mismatch | `ServerNameToVerify` must match ACM cert, not ALB DNS |
| DB connection refused | Missing security group | ECS has TWO SGs (instances + tasks) - allow both |
| CORS errors | Domain not allowed | Add to CORS middleware config |
| SPA 404 on refresh | No fallback config | Copy to index.html or add `_redirects` |
| Build ok, deploy fails | Output path mismatch | Check build output matches deploy config |
| Env vars undefined | Build vs runtime | `VITE_*` baked at build, others at runtime |
