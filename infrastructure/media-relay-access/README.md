# Media relay access

Supplies a Cloudflare TURN credential for media that cannot connect directly.
The product-purpose name replaces the provider/mechanism name `cloudflare-turn`.
The physical key name remains `chalk-production-turn` and logical ID `Turn`.

Production only; ported, deliberately not deployed. Creating or adopting a key
requires a separate cutover decision and read/create authority. Missing state
is not proof that a physical key does not exist. The guarded provider refuses
unexpected replacement and retains the key on removal.

`config.ts` validates the production stage. Cloudflare credentials come from
`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`; state follows the shared AWS
credential rule. There is no private workload input file for this stack.
