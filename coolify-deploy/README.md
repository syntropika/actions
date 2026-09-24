# Coolify Deploy

This action configures an existing Coolify resource and starts a deployment. It supports application and service environment variables, optional application or service configuration changes, Docker Image tags or digests, deployment by resource UUID or Coolify tag, pull request previews, waiting for deployment completion, and an optional HTTP health check. It does not create projects, applications, services, or servers.

The action uses the [Coolify deployment API](https://coolify.io/docs/api/endpoints/deployments/deploy-by-tag-or-uuid). It runs on Node.js 24, so callers do not need Bun or a checked-out copy of this repository.

## Example: deploy a Docker Image application

Build and publish the image in a prior job. The following job synchronizes runtime secrets and deploys the exact image tag:

```yaml
jobs:
  deploy:
    needs: publish
    if: vars.COOLIFY_APP_UUID != ''
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Deploy
        id: coolify
        uses: syntropika/actions/coolify-deploy@v1
        env:
          COOLIFY_ENV_APP_TOKEN: ${{ secrets.APP_TOKEN }}
        with:
          url: ${{ vars.COOLIFY_URL }}
          uuids: ${{ vars.COOLIFY_APP_UUID }}
          resource-type: application
          required-env-keys: APP_TOKEN
          image-name: ghcr.io/example/app
          image-tag: ${{ github.sha }}
          read-token: ${{ secrets.COOLIFY_READ_TOKEN }}
          write-token: ${{ secrets.COOLIFY_WRITE_TOKEN }}
          deploy-token: ${{ secrets.COOLIFY_DEPLOY_TOKEN }}
```

Variables from the step's `env:` whose names start with `COOLIFY_ENV_` are synced after that prefix is removed. Put secret values in GitHub Secrets, not in workflow YAML. `required-env-keys` fails the step before contacting Coolify if a listed value is missing or empty. Optional secrets can be empty strings. The action does not print environment values or API response bodies, and masks nonempty values. All simple variables are runtime-only and marked as shown only once in Coolify.

## Example: SOPS-encrypted environment

For a checked-in SOPS-encrypted JSON object, check out the repository and supply the AGE private key from GitHub Secrets:

```yaml
- uses: actions/checkout@v4
- name: Deploy from SOPS
  uses: syntropika/actions/coolify-deploy@v1
  with:
    url: ${{ vars.COOLIFY_URL }}
    uuids: ${{ vars.COOLIFY_APP_UUID }}
    resource-type: application
    sops-file: deployment/sops/environments/production.sops.json
    sops-age-key: ${{ secrets.SOPS_AGE_KEY }}
    sops-env-keys: DATABASE_URL,APP_SECRET
    required-env-keys: DATABASE_URL,APP_SECRET
```

The action downloads the pinned SOPS v3.13.3 binary for Linux or macOS x64/arm64, checks its SHA-256 digest against the official release, and decrypts in memory. It never writes decrypted JSON to disk or exposes it as an action output. A `COOLIFY_API_TOKEN` string in the decrypted object supplies the deploy, read, and write tokens when their explicit inputs are omitted; it is never synced as a runtime variable. Use `sops-token-key` if your token has another name. The token needs all permissions used by the step. By default all other SOPS keys are synced; `sops-env-keys` restricts them to an allowlist. Prefixed step variables and `env-file` may also be used, provided their keys do not overlap.

## Other deployment modes

Deploy resources selected by Coolify tags without changing configuration:

```yaml
- uses: syntropika/actions/coolify-deploy@v1
  with:
    url: ${{ vars.COOLIFY_URL }}
    tags: backend,workers
    deploy-token: ${{ secrets.COOLIFY_DEPLOY_TOKEN }}
    wait: 'false'
```

For a service, set `resource-type: service` and supply variables through step `env:`, `sops-file`, or `env-file`. For an application, use `resource-type: application`. The default `auto` checks the application endpoint first, then the service endpoint, and requires a token with read permission. A single action invocation can update environment or configuration for one UUID; tag-based or multi-resource deployment uses a separate invocation after configuration.

An advanced environment file is an array of objects. Each object must have `key` and string `value` fields and may set `is_runtime`, `is_buildtime`, `is_preview`, `is_literal`, `is_multiline`, `is_shown_once`, or `comment`:

```json
[
  {"key":"APP_ENV","value":"production","is_shown_once":false},
  {"key":"DATABASE_URL","value":"<set-on-runner>","is_shown_once":true}
]
```

`prune-env-keys` names the variables owned by this action. A managed key absent from all supplied environment sources is removed from the target resource; unrelated and preview variables remain untouched. With no supplied variables, `prune-env-keys` removes all listed non-preview keys. `patch-file` accepts a JSON object of fields supported by Coolify's [application](https://coolify.io/docs/api/endpoints/applications/update-application-by-uuid) or [service](https://coolify.io/docs/api/endpoints/services/update-service-by-uuid) update endpoint. The action submits the object without adding defaults. Use `image-name` and `image-tag` for a Docker Image application when you want the action to verify the image repository and normalize a `sha256:<digest>` to Coolify's `sha256-<digest>` tag format.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `url` | Yes | HTTPS Coolify URL, with or without `/api/v1`. |
| `deploy-token` | Unless supplied by SOPS | Token with `deploy` permission. |
| `uuids` or `tags` | Exactly one | Comma-separated resource UUIDs or Coolify resource tags. |
| `read-token` | To wait or inspect | Token with `read` permission. A `write-token` that also has `read` may serve both roles. |
| `write-token` | To configure | Token with `write` permission for environment variables, pruning, patches, or image selection. |
| `resource-type` | No | `application`, `service`, or `auto` (default). Only used while configuring a resource. |
| `env-file` | No | Runner-local JSON object or array of environment variables. |
| `env-prefix` | No | Step environment prefix to sync, default `COOLIFY_ENV_`. |
| `required-env-keys` | No | Comma-separated environment keys that must be nonempty before contacting Coolify. |
| `sops-file` | No | Path to a SOPS-encrypted JSON object; requires checkout. |
| `sops-age-key` | With `sops-file` | AGE private key supplied through GitHub Secrets. |
| `sops-token-key` | No | Decrypted key used as Coolify API token fallback and excluded from syncing; default `COOLIFY_API_TOKEN`. |
| `sops-env-keys` | No | Comma-separated SOPS key allowlist; defaults to every decrypted key except the token. |
| `prune-env-keys` | No | Comma-separated list of environment keys this action may remove when absent from all supplied sources. |
| `patch-file` | No | Runner-local JSON object of application or service update fields. |
| `image-name`, `image-tag` | Together | Verify the existing Docker Image repository and update its tag or digest. |
| `force` | No | Force rebuild without cache; default `false`. |
| `pull-request-id` | No | Deploy a Coolify preview for this pull request ID. Cannot be combined with `tags`. |
| `docker-tag` | No | Docker Image preview tag override; requires `pull-request-id`. |
| `wait` | No | Poll returned deployment UUIDs until completion; default `true`. Set `false` for a deploy-only token. |
| `timeout-seconds` | No | Overall wait limit; default `1200`. |
| `poll-interval-seconds` | No | Poll interval; default `10`. |
| `health-url` | No | HTTPS endpoint checked after all observable deployments finish; requires `wait: true`. |
| `health-status` | No | Expected HTTP status from `health-url`; default `200`. |
| `health-timeout-seconds` | No | Health-check timeout after deployment; default `360`. |

The action returns `deployments` (JSON array), `deployment-uuids` (comma-separated), and `status` (`finished`, `accepted`, or `partially-observed`). Coolify can accept a resource without returning a deployment UUID. In that case the action reports acceptance but cannot observe completion for that resource. When it receives a UUID, `wait: true` fails the step on a failed, cancelled, or timed-out deployment.

Create API tokens for the team that owns the resource. Coolify treats `deploy` as a deploy-only permission; configuration updates need `write` and status checks need `read`. See [Coolify API permissions](https://coolify.io/docs/api/permissions). Configure registry credentials on the Coolify deployment server if the image is private.
