# Living Atlas Single Authority Module

This module creates the stable Cloudflare storage resources for a single
Living Atlas authority:

- R2 bucket for encrypted graph custody.
- D1 database for opaque control/audit metadata.
- Workers KV namespace for small opaque config/session records.

Worker code deployment, Durable Object migrations, and Worker secrets stay with
Wrangler. Personal account ids, routes, tfvars, state, and bootstrap material
must live outside the public repo.
