# Discovery Genome service API

The browser workspace and the Orbita MCP bridge share the same PostgreSQL-backed, tenant-scoped Discovery Genome.
The service API is intentionally mounted at `/api/internal/discovery-genome` and reuses the same operator and
tournament functions as the authenticated browser routes.

## Guided UI variables

- `ORBITA_GENOME_SERVICE_TOKEN`: a random shared secret of at least 32 characters.
- `ORBITA_GENOME_SERVICE_ALLOWED_USERS`: comma-separated Guided UI usernames allowed through this bridge.

Requests must provide:

- `Authorization: Bearer <shared secret>`
- `X-Orbita-Genome-User: <allowlisted username>`

The server resolves that username to an active user row and supplies the resulting tenant UUID internally. Callers
cannot submit a tenant UUID. When the token or allowlist is absent, the endpoint fails closed with HTTP 503.

## MCP variables

On `orbita-agent-research-server`, set:

- `ORBITA_DISCOVERY_GENOME_URL` to this Guided UI origin.
- `ORBITA_DISCOVERY_GENOME_SERVICE_TOKEN` to the same secret.
- `ORBITA_DISCOVERY_GENOME_USERNAME` to one allowlisted Guided UI username.

Do not expose this service token in browser JavaScript, a public repository, logs, or ChatGPT messages. Rotate it by
changing both Railway services and redeploying them.

## Governance

The service API does not weaken the underlying rules: frozen operator versions are immutable, tournament manifests
exclude revealed results, and each entry result can be recorded only once. The MCP adds exact review-hash and
confirmation-phrase gates before calling irreversible routes.


## Irreversible-action receipts

Freeze requests must include the exact `expected_review_hash` returned by the preceding operator or tournament read.
The service locks the tenant-owned database row, recomputes the current hash, and rejects a mismatch before changing
state.

Tournament result approval hashes cover the complete operation:

```json
{
  "schema": "orbita.discovery-tournament-result.v1",
  "tournament_id": "<target tournament>",
  "entry_id": "<target entry>",
  "verdict": "survived | refuted | inconclusive",
  "result": {}
}
```

The result endpoint requires `expected_result_hash`, recomputes it under the tenant-scoped transaction, persists it
with the entry, and returns the persisted receipt for MCP verification.
