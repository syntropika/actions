# Coolify Deploy

This action configures a Coolify resource and starts a deployment. It supports application and service environment variables, optional application or service configuration changes, Docker Image tags or digests, deployment by resource UUID or Coolify tag, pull request previews, waiting for deployment completion, and an optional HTTP health check. A Docker Image application can also be found by a stable slug and created when missing. The action does not create projects, environments, services, or servers.

The action uses the [Coolify deployment API](https://coolify.io/docs/api/endpoints/deployments/deploy-by-tag-or-uuid). It runs on Node.js 24, so callers do not need Bun or a checked-out copy of this repository.

## Example: create or reuse a Docker Image application by slug

Declare the target in the calling workflow. Keep only application settings that do not fit the action inputs in a JSON file:

```json
{
  "create": {
    "autogenerate_domain": false,
    "health_check_enabled": false
  },
  "update": {
    "health_check_enabled": false,
    "stop_grace_period": 300
  },
  "storages": [
    { "name": "call-recorder-bot-data", "mount_path": "/app/data" }
  ]
}
```

Then reference it from the deployment step:

```yaml
- uses: actions/checkout@v4
- name: Deploy
  uses: syntropika/actions/coolify-deploy@v2
  with:
    url: ${{ vars.COOLIFY_URL }}
    application-slug: call-recorder-bot
    project: syntropika
    server: ovh1
    environment: production
    create-if-missing: 'true'
    application-file: deployment/coolify/application.json
    image-name: ghcr.io/${{ github.repository }}
    image-tag: ${{ github.sha }}
    token: ${{ secrets.COOLIFY_TOKEN }}
```

The action resolves the project, environment, and server by exact name or UUID. Declare them in the workflow so the deployment target is visible beside the action call. `project` and `server` may be omitted only when the API token can see exactly one of each; `environment` defaults to `production`. It finds an application by slug within that project, environment, and server. A missing application is created from the image, then its persistent storages, environment variables, and update settings are applied before deployment. Existing matching storage is reused. Duplicate slugs or conflicting storage definitions fail the step. Set `create-if-missing: 'false'` to require an existing application. The API still uses the resolved resource UUID internally; the workflow does not need to store it.

`create` accepts fields from Coolify's [Docker Image create endpoint](https://coolify.io/docs/api/endpoints/applications/create-dockerimage-application). `update` accepts fields from its [application update endpoint](https://coolify.io/docs/api/endpoints/applications/update-application-by-uuid). The action owns the project, server, environment, name, image repository, and image tag fields, and disables instant deployment during creation so storage and secrets can be configured first. `storages` currently manages named persistent volumes by name and container mount path. Projects, environments, and servers must already exist.

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
        uses: syntropika/actions/coolify-deploy@v2
        env:
          COOLIFY_ENV_APP_TOKEN: ${{ secrets.APP_TOKEN }}
        with:
          url: ${{ vars.COOLIFY_URL }}
          uuids: ${{ vars.COOLIFY_APP_UUID }}
          resource-type: application
          required-env-keys: APP_TOKEN
          image-name: ghcr.io/example/app
          image-tag: ${{ github.sha }}
          token: ${{ secrets.COOLIFY_TOKEN }}
```

Variables from the step's `env:` whose names start with `COOLIFY_ENV_` are synced after that prefix is removed. Put secret values in GitHub Secrets, not in workflow YAML. `required-env-keys` fails the step before contacting Coolify if a listed value is missing or empty. Optional secrets can be empty strings. The action does not print environment values or API response bodies, and masks nonempty values. All simple variables are runtime-only and marked as shown only once in Coolify.

## Example: SOPS-encrypted environment

For a checked-in SOPS-encrypted JSON object, check out the repository and supply the AGE private key from GitHub Secrets:

```yaml
- uses: actions/checkout@v4
- name: Deploy from SOPS
  uses: syntropika/actions/coolify-deploy@v2
  with:
    url: ${{ vars.COOLIFY_URL }}
    uuids: ${{ vars.COOLIFY_APP_UUID }}
    resource-type: application
    sops-file: deployment/sops/environments/production.sops.json
    sops-age-key: ${{ secrets.SOPS_AGE_KEY }}
    sops-env-keys: DATABASE_URL,APP_SECRET
    required-env-keys: DATABASE_URL,APP_SECRET
```

The action downloads the pinned SOPS v3.13.3 binary for Linux or macOS x64/arm64, checks its SHA-256 digest against the official release, and decrypts in memory. It never writes decrypted JSON to disk or exposes it as an action output. A `COOLIFY_API_TOKEN` string in the decrypted object supplies `token` when that input is omitted; it is never synced as a runtime variable. Use `sops-token-key` if your token has another name. The token needs every permission used by the step. By default all other SOPS keys are synced; `sops-env-keys` restricts them to an allowlist. Prefixed step variables and `env-file` may also be used, provided their keys do not overlap.

## Other deployment modes

Deploy resources selected by Coolify tags without changing configuration:

```yaml
- uses: syntropika/actions/coolify-deploy@v2
  with:
    url: ${{ vars.COOLIFY_URL }}
    tags: backend,workers
    token: ${{ secrets.COOLIFY_TOKEN }}
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
| `token` | Unless supplied by SOPS | Coolify API token with all permissions used by the step. |
| `uuids`, `tags`, or `application-slug` | Exactly one | Resource UUIDs, Coolify tags, or a Docker Image application name. Legacy `application-file` identity fields are also accepted. |
| `resource-type` | No | `application`, `service`, or `auto` (default). Only used while configuring a resource. |
| `application-slug` | For name-based deployment | Stable Docker Image application name; requires `image-name`, `image-tag`, and a token that can read and write. |
| `project`, `server`, `environment` | With `application-slug` | Existing target names or UUIDs; `environment` defaults to `production`. |
| `create-if-missing` | No | Create a missing Docker Image application; defaults to `true`. |
| `application-file` | No | Optional runner-local JSON with `create`, `update`, and `storages` settings; requires checkout. |
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

Create the API token for the team that owns the resource. The action sends the same token to every Coolify endpoint and reports an HTTP error when Coolify denies an operation. A deployment-only call with `wait: 'false'` can use a `deploy` token. Configuration and observed deployments also need `write` and `read`; Coolify's dashboard creates `deploy` as a deploy-only token, so one token for all three operations needs `root`. See [Coolify API permissions](https://coolify.io/docs/api/permissions). Configure registry credentials on the Coolify deployment server if the image is private.
