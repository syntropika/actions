import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// coolify-deploy/src/main.ts
import { appendFileSync } from "node:fs";

// coolify-deploy/src/core.ts
import { readFile } from "node:fs/promises";
var defaultDependencies = {
  fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: Date.now,
  readFile: (path) => readFile(path, "utf8"),
  log: console.log,
  onAccepted: () => {}
};
function required(value, name) {
  const trimmed = value.trim();
  if (!trimmed)
    throw new Error(`${name} is required`);
  return trimmed;
}
function csv(value) {
  if (!value.trim())
    return [];
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => !item))
    throw new Error("Comma-separated inputs cannot contain empty entries");
  return [...new Set(items)];
}
function boolean(value, name) {
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  throw new Error(`${name} must be true or false`);
}
function positiveInteger(value, name, max) {
  if (!/^\d+$/.test(value))
    throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be between 1 and ${max}`);
  }
  return parsed;
}
function baseUrl(value) {
  let url;
  try {
    url = new URL(required(value, "url"));
  } catch {
    throw new Error("url must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("url must be HTTPS and must not contain credentials, a query, or a fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "" && path !== "/api/v1") {
    throw new Error("url must point to the Coolify origin or its /api/v1 endpoint");
  }
  url.pathname = "/api/v1/";
  return url;
}
function record(value, context) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value;
}
async function jsonFile(path, context, deps) {
  let raw;
  try {
    raw = await deps.readFile(path);
  } catch {
    throw new Error(`Could not read ${context} file`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${context} file must contain valid JSON`);
  }
}
function environment(value) {
  const defaults = {
    is_runtime: true,
    is_buildtime: false,
    is_preview: false,
    is_literal: true,
    is_shown_once: true
  };
  const entries = Array.isArray(value) ? value : Object.entries(record(value, "Environment file")).map(([key, entryValue]) => ({
    key,
    value: entryValue
  }));
  const seen = new Set;
  return entries.map((entry, index) => {
    const item = record(entry, `Environment entry ${index + 1}`);
    if (typeof item.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.key)) {
      throw new Error(`Environment entry ${index + 1} has an invalid key`);
    }
    if (seen.has(item.key))
      throw new Error(`Environment file has duplicate key ${item.key}`);
    seen.add(item.key);
    if (typeof item.value !== "string") {
      throw new Error(`Environment entry ${item.key} must have a string value`);
    }
    const allowed = new Set([
      "key",
      "value",
      "is_runtime",
      "is_buildtime",
      "is_preview",
      "is_literal",
      "is_shown_once",
      "is_multiline",
      "comment"
    ]);
    for (const [key, flag] of Object.entries(item)) {
      if (!allowed.has(key))
        throw new Error(`Environment entry ${item.key} has unsupported field ${key}`);
      if (key.startsWith("is_") && typeof flag !== "boolean") {
        throw new Error(`Environment entry ${item.key} field ${key} must be boolean`);
      }
      if (key === "comment" && typeof flag !== "string") {
        throw new Error(`Environment entry ${item.key} comment must be a string`);
      }
    }
    return { ...defaults, ...item };
  });
}
function pathPart(value, name) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`${name} contains an invalid identifier`);
  return value;
}
function imageTag(value) {
  if (/^sha256:[a-f0-9]{64}$/.test(value))
    return value.replace(":", "-");
  if (!/^[\w][\w.-]{0,127}$/.test(value))
    throw new Error("image-tag is invalid");
  return value;
}

class Coolify {
  root;
  deps;
  constructor(root, deps) {
    this.root = root;
    this.deps = deps;
  }
  async request(method, path, token, body) {
    const url = new URL(path.replace(/^\//, ""), this.root);
    let response;
    try {
      response = await this.deps.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...body === undefined ? {} : { "Content-Type": "application/json" }
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30000)
      });
    } catch {
      throw new Error(`${method} ${url.pathname} could not reach Coolify`);
    }
    let data = null;
    const raw = await response.text();
    if (raw && response.ok) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`${method} ${url.pathname} returned invalid JSON`);
      }
    }
    return { status: response.status, data };
  }
  async expect(method, path, token, body) {
    const result = await this.request(method, path, token, body);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`${method} ${path} failed with HTTP ${result.status}`);
    }
    return result.data;
  }
}
function deploymentList(value) {
  const body = record(value, "Deploy response");
  if (!Array.isArray(body.deployments) || body.deployments.length === 0) {
    throw new Error("Coolify returned no deployments");
  }
  return body.deployments.map((value2, index) => {
    const entry = record(value2, `Deployment ${index + 1}`);
    if (typeof entry.resource_uuid !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.resource_uuid)) {
      throw new Error(`Deployment ${index + 1} has no resource UUID`);
    }
    if (entry.deployment_uuid !== undefined && entry.deployment_uuid !== null && entry.deployment_uuid !== "" && (typeof entry.deployment_uuid !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.deployment_uuid))) {
      throw new Error(`Deployment ${index + 1} has an invalid deployment UUID`);
    }
    return {
      resource_uuid: entry.resource_uuid,
      deployment_uuid: entry.deployment_uuid || undefined,
      message: typeof entry.message === "string" ? entry.message : undefined
    };
  });
}
async function resourceType(requested, uuid, client, readToken) {
  if (requested === "application" || requested === "service")
    return requested;
  if (requested !== "auto")
    throw new Error("resource-type must be application, service, or auto");
  if (!readToken)
    throw new Error("read-token is required to detect resource type");
  const application = await client.request("GET", `applications/${uuid}`, readToken);
  if (application.status >= 200 && application.status < 300)
    return "application";
  if (application.status !== 404)
    throw new Error(`GET applications/${uuid} failed with HTTP ${application.status}`);
  const service = await client.request("GET", `services/${uuid}`, readToken);
  if (service.status >= 200 && service.status < 300)
    return "service";
  throw new Error(`Could not find application or service ${uuid} (service lookup HTTP ${service.status})`);
}
async function deploy(inputs, deps = defaultDependencies) {
  const uuids = csv(inputs.uuids).map((uuid) => pathPart(uuid, "uuids"));
  const tags = csv(inputs.tags);
  if (uuids.length > 0 === tags.length > 0) {
    throw new Error("Set exactly one of uuids or tags");
  }
  const mutating = Boolean(inputs.envFile || inputs.pruneEnvKeys || inputs.patchFile || inputs.imageTag);
  if (mutating && (uuids.length !== 1 || tags.length > 0)) {
    throw new Error("Environment and configuration updates require exactly one resource UUID");
  }
  const force = boolean(inputs.force, "force");
  const wait = boolean(inputs.wait, "wait");
  const timeout = positiveInteger(inputs.timeoutSeconds, "timeout-seconds", 86400) * 1000;
  const interval = positiveInteger(inputs.pollIntervalSeconds, "poll-interval-seconds", 3600) * 1000;
  const healthStatus = positiveInteger(inputs.healthStatus, "health-status", 599);
  const healthTimeout = positiveInteger(inputs.healthTimeoutSeconds, "health-timeout-seconds", 86400) * 1000;
  if (healthStatus < 100)
    throw new Error("health-status must be a valid HTTP status code");
  if (inputs.healthUrl && !wait)
    throw new Error("health-url requires wait: true");
  let healthUrl;
  if (inputs.healthUrl) {
    try {
      healthUrl = new URL(inputs.healthUrl);
    } catch {
      throw new Error("health-url must be a valid HTTPS URL");
    }
    if (healthUrl.protocol !== "https:" || healthUrl.username || healthUrl.password || healthUrl.hash) {
      throw new Error("health-url must be HTTPS and must not contain credentials or a fragment");
    }
  }
  const prId = inputs.pullRequestId ? positiveInteger(inputs.pullRequestId, "pull-request-id", 2147483647) : undefined;
  if (prId && tags.length > 0)
    throw new Error("pull-request-id cannot be used with tags");
  if (inputs.dockerTag && !prId)
    throw new Error("docker-tag requires pull-request-id");
  if (inputs.imageTag && (prId || inputs.dockerTag)) {
    throw new Error("image-tag cannot be combined with preview deployment options");
  }
  if (inputs.imageTag && !inputs.imageName)
    throw new Error("image-name is required with image-tag");
  if (inputs.imageName && !inputs.imageTag)
    throw new Error("image-tag is required with image-name");
  if (mutating && !inputs.writeToken)
    throw new Error("write-token is required for configuration updates");
  const readToken = inputs.readToken || inputs.writeToken;
  if (wait && !readToken)
    throw new Error("read-token is required when wait is true");
  const token = required(inputs.deployToken, "deploy-token");
  const client = new Coolify(baseUrl(inputs.url), deps);
  if (mutating) {
    const uuid = uuids[0];
    const kind = await resourceType(inputs.resourceType, uuid, client, readToken);
    const path = `${kind}s/${uuid}`;
    let envs;
    if (inputs.envFile)
      envs = environment(await jsonFile(inputs.envFile, "Environment", deps));
    const managed = new Set(csv(inputs.pruneEnvKeys));
    for (const key of managed) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw new Error(`Invalid managed environment key ${key}`);
    }
    const existing = managed.size > 0 ? await client.expect("GET", `${path}/envs`, readToken) : undefined;
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error("Coolify returned an invalid environment list");
    }
    const patch = inputs.patchFile ? record(await jsonFile(inputs.patchFile, "Patch", deps), "Patch file") : {};
    if (inputs.imageTag) {
      if (kind !== "application")
        throw new Error("image-tag requires an application");
      const application = record(await client.expect("GET", path, readToken), "Application response");
      if (application.build_pack !== "dockerimage" || application.docker_registry_image_name !== inputs.imageName) {
        throw new Error("The target is not the expected Docker Image application");
      }
      if (patch.docker_registry_image_tag !== undefined) {
        throw new Error("Set image-tag or docker_registry_image_tag in patch-file, not both");
      }
      patch.docker_registry_image_tag = imageTag(inputs.imageTag);
    }
    if (envs && envs.length > 0) {
      await client.expect("PATCH", `${path}/envs/bulk`, inputs.writeToken, { data: envs });
      deps.log(`Updated ${envs.length} environment variables for ${kind} ${uuid}`);
    }
    if (managed.size > 0 && Array.isArray(existing)) {
      const desired = new Set((envs ?? []).filter((entry) => entry.is_preview !== true).map((entry) => entry.key));
      for (const value of existing) {
        const entry = record(value, "Existing environment variable");
        if (typeof entry.key !== "string" || !managed.has(entry.key) || desired.has(entry.key) || entry.is_preview === true)
          continue;
        if (typeof entry.uuid !== "string")
          throw new Error(`Environment variable ${entry.key} has no UUID`);
        await client.expect("DELETE", `${path}/envs/${pathPart(entry.uuid, "environment UUID")}`, inputs.writeToken);
        deps.log(`Removed managed environment variable ${entry.key}`);
      }
    }
    if (Object.keys(patch).length > 0) {
      await client.expect("PATCH", path, inputs.writeToken, patch);
      deps.log(`Updated ${kind} configuration for ${uuid}`);
    }
  }
  const payload = { force };
  if (uuids.length > 0)
    payload.uuid = uuids.join(",");
  if (tags.length > 0)
    payload.tag = tags.join(",");
  if (prId)
    payload.pull_request_id = prId;
  if (inputs.dockerTag)
    payload.docker_tag = inputs.dockerTag;
  const accepted = deploymentList(await client.expect("POST", "deploy", token, payload));
  deps.onAccepted(accepted);
  for (const entry of accepted) {
    deps.log(`Coolify accepted ${entry.resource_uuid}: ${entry.deployment_uuid || "no deployment UUID"}`);
  }
  if (!wait)
    return { deployments: accepted, status: "accepted" };
  const pending = new Set(accepted.map((item) => item.deployment_uuid).filter((id) => Boolean(id)));
  if (pending.size === 0) {
    if (healthUrl)
      throw new Error("Coolify did not return a deployment UUID; health check cannot identify the new deployment");
    return { deployments: accepted, status: "accepted" };
  }
  const deadline = deps.now() + timeout;
  while (pending.size > 0) {
    if (deps.now() >= deadline)
      throw new Error(`Timed out waiting for ${pending.size} Coolify deployment(s)`);
    for (const id of [...pending]) {
      const response = record(await client.expect("GET", `deployments/${pathPart(id, "deployment UUID")}`, readToken), "Deployment status");
      if (response.status === "finished") {
        pending.delete(id);
        deps.log(`Coolify deployment ${id} finished`);
      } else if (response.status !== "queued" && response.status !== "in_progress") {
        throw new Error(`Coolify deployment ${id} ended with status ${String(response.status)}`);
      }
    }
    if (pending.size > 0)
      await deps.sleep(Math.min(interval, Math.max(0, deadline - deps.now())));
  }
  if (healthUrl) {
    const healthDeadline = deps.now() + healthTimeout;
    let healthy = false;
    while (deps.now() < healthDeadline) {
      try {
        const response = await deps.fetch(healthUrl, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(30000)
        });
        if (response.status === healthStatus) {
          healthy = true;
          break;
        }
      } catch {}
      await deps.sleep(Math.min(interval, Math.max(0, healthDeadline - deps.now())));
    }
    if (!healthy)
      throw new Error("The health URL did not return the expected status before the timeout");
    deps.log("Health check passed");
  }
  return {
    deployments: accepted,
    status: accepted.some((item) => !item.deployment_uuid) ? "partially-observed" : "finished"
  };
}

// coolify-deploy/src/main.ts
function input(name, fallback = "") {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? fallback;
}
function output(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path)
    throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(path, `${name}=${value}
`);
}
function accepted(deployments) {
  output("deployments", JSON.stringify(deployments));
  output("deployment-uuids", deployments.map((item) => item.deployment_uuid).filter(Boolean).join(","));
}
var inputs = {
  url: input("url"),
  deployToken: input("deploy-token"),
  readToken: input("read-token"),
  writeToken: input("write-token"),
  uuids: input("uuids"),
  tags: input("tags"),
  resourceType: input("resource-type", "auto"),
  envFile: input("env-file"),
  pruneEnvKeys: input("prune-env-keys"),
  patchFile: input("patch-file"),
  imageName: input("image-name"),
  imageTag: input("image-tag"),
  force: input("force", "false"),
  pullRequestId: input("pull-request-id"),
  dockerTag: input("docker-tag"),
  wait: input("wait", "true"),
  timeoutSeconds: input("timeout-seconds", "1200"),
  pollIntervalSeconds: input("poll-interval-seconds", "10"),
  healthUrl: input("health-url"),
  healthStatus: input("health-status", "200"),
  healthTimeoutSeconds: input("health-timeout-seconds", "360")
};
try {
  const result = await deploy(inputs, {
    fetch,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: Date.now,
    readFile: async (path) => (await import("node:fs/promises")).readFile(path, "utf8"),
    log: console.log,
    onAccepted: accepted
  });
  output("status", result.status);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error(`::error::${message.replace(/[\r\n]/g, " ")}`);
  process.exitCode = 1;
}
