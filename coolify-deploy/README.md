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
      - name: Prepare runtime environment
        env:
          APP_TOKEN: ${{ secrets.APP_TOKEN }}
        run: |
          umask 077
          node -e 'const fs = require("node:fs"); fs.writeFileSync(process.env.RUNNER_TEMP + "/coolify-env.json", JSON.stringify({APP_TOKEN: process.env.APP_TOKEN}))'

      - name: Deploy
        id: coolify
        uses: syntropika/actions/coolify-deploy@v1
        with:
          url: ${{ vars.COOLIFY_URL }}
          uuids: ${{ vars.COOLIFY_APP_UUID }}
          resource-type: application
          env-file: ${{ runner.temp }}/coolify-env.json
          image-name: ghcr.io/example/app
          image-tag: ${{ github.sha }}
          read-token: ${{ secrets.COOLIFY_READ_TOKEN }}
          write-token: ${{ secrets.COOLIFY_WRITE_TOKEN }}
          deploy-token: ${{ secrets.COOLIFY_DEPLOY_TOKEN }}
```

The environment file is created on the runner and is never uploaded as an artifact. Put the values in GitHub Secrets, not in workflow YAML or a committed file. The action does not print environment values or API response bodies. A simple JSON object sets runtime variables and marks them as shown only once in Coolify.

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

For a service, set `resource-type: service` and provide `env-file`. For an application, use `resource-type: application`. The default `auto` checks the application endpoint first, then the service endpoint, and requires a token with read permission. A single action invocation can update environment or configuration for one UUID; tag-based or multi-resource deployment uses a separate invocation after configuration.

An advanced environment file is an array of objects. Each object must have `key` and string `value` fields and may set `is_runtime`, `is_buildtime`, `is_preview`, `is_literal`, `is_multiline`, `is_shown_once`, or `comment`:

```json
[
  {"key":"APP_ENV","value":"production","is_shown_once":false},
  {"key":"DATABASE_URL","value":"<set-on-runner>","is_shown_once":true}
]
```

`prune-env-keys` names the variables owned by this action. A managed key absent from the environment file is removed from the target resource; unrelated and preview variables remain untouched. An empty environment file together with `prune-env-keys` removes all listed non-preview keys. `patch-file` accepts a JSON object of fields supported by Coolify's [application](https://coolify.io/docs/api/endpoints/applications/update-application-by-uuid) or [service](https://coolify.io/docs/api/endpoints/services/update-service-by-uuid) update endpoint. The action submits the object without adding defaults. Use `image-name` and `image-tag` for a Docker Image application when you want the action to verify the image repository and normalize a `sha256:<digest>` to Coolify's `sha256-<digest>` tag format.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `url` | Yes | HTTPS Coolify URL, with or without `/api/v1`. |
| `deploy-token` | Yes | Token with `deploy` permission. |
| `uuids` or `tags` | Exactly one | Comma-separated resource UUIDs or Coolify resource tags. |
| `read-token` | To wait or inspect | Token with `read` permission. A `write-token` that also has `read` may serve both roles. |
| `write-token` | To configure | Token with `write` permission for environment variables, pruning, patches, or image selection. |
| `resource-type` | No | `application`, `service`, or `auto` (default). Only used while configuring a resource. |
| `env-file` | No | Runner-local JSON object or array of environment variables. |
| `prune-env-keys` | No | Comma-separated list of environment keys this action may remove when absent from `env-file`. |
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
