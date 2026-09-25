import { readFile } from "node:fs/promises";
import { decryptSops } from "./sops.ts";
import { applicationSpec, resolveApplication, syncPersistentStorages } from "./application.ts";

type ResourceType = "application" | "service";
type JsonRecord = Record<string, unknown>;

export interface Inputs {
  url: string;
  token: string;
  uuids: string;
  tags: string;
  resourceType: string;
  applicationSlug: string;
  project: string;
  server: string;
  destination: string;
  environment: string;
  createIfMissing: string;
  applicationFile: string;
  envFile: string;
  envPrefix: string;
  requiredEnvKeys: string;
  sopsFile: string;
  sopsAgeKey: string;
  sopsTokenKey: string;
  sopsEnvKeys: string;
  pruneEnvKeys: string;
  patchFile: string;
  imageName: string;
  imageTag: string;
  force: string;
  pullRequestId: string;
  dockerTag: string;
  wait: string;
  timeoutSeconds: string;
  pollIntervalSeconds: string;
  healthUrl: string;
  healthStatus: string;
  healthTimeoutSeconds: string;
}

export interface Deployment {
  message?: string;
  resource_uuid?: string;
  deployment_uuid?: string;
}

export interface Result {
  deployments: Deployment[];
  status: "finished" | "accepted" | "partially-observed";
}

export interface Dependencies {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  readFile: (path: string) => Promise<string>;
  environmentVariables: NodeJS.ProcessEnv;
  decryptSops: (path: string, ageKey: string) => Promise<unknown>;
  mask: (value: string) => void;
  log: (message: string) => void;
  onAccepted: (deployments: Deployment[]) => void;
}

export const defaultDependencies: Dependencies = {
  fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: Date.now,
  readFile: (path) => readFile(path, "utf8"),
  environmentVariables: process.env,
  decryptSops,
  mask: (value) => console.log(`::add-mask::${value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`),
  log: console.log,
  onAccepted: () => {},
};

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function csv(value: string): string[] {
  if (!value.trim()) return [];
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => !item)) throw new Error("Comma-separated inputs cannot contain empty entries");
  return [...new Set(items)];
}

function boolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function positiveInteger(value: string, name: string, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be between 1 and ${max}`);
  }
  return parsed;
}

function baseUrl(value: string): URL {
  let url: URL;
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

function record(value: unknown, context: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as JsonRecord;
}

async function jsonFile(path: string, context: string, deps: Dependencies): Promise<unknown> {
  let raw: string;
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

function environment(value: unknown): JsonRecord[] {
  const defaults = {
    is_runtime: true,
    is_buildtime: false,
    is_preview: false,
    is_literal: true,
    is_shown_once: true,
  };
  const entries = Array.isArray(value)
    ? value
    : Object.entries(record(value, "Environment file")).map(([key, entryValue]) => ({
        key,
        value: entryValue,
      }));
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const item = record(entry, `Environment entry ${index + 1}`);
    if (typeof item.key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.key)) {
      throw new Error(`Environment entry ${index + 1} has an invalid key`);
    }
    if (seen.has(item.key)) throw new Error(`Environment file has duplicate key ${item.key}`);
    seen.add(item.key);
    if (typeof item.value !== "string") {
      throw new Error(`Environment entry ${item.key} must have a string value`);
    }
    const allowed = new Set([
      "key", "value", "is_runtime", "is_buildtime", "is_preview", "is_literal",
      "is_shown_once", "is_multiline", "comment",
    ]);
    for (const [key, flag] of Object.entries(item)) {
      if (!allowed.has(key)) throw new Error(`Environment entry ${item.key} has unsupported field ${key}`);
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

async function environmentSources(inputs: Inputs, deps: Dependencies): Promise<{ entries: JsonRecord[]; sopsToken: string }> {
  const prefix = required(inputs.envPrefix, "env-prefix");
  if (!/^[A-Za-z_][A-Za-z0-9_]*_$/.test(prefix)) {
    throw new Error("env-prefix must be an environment variable prefix ending in underscore");
  }
  const sources: Array<[string, JsonRecord[]]> = [];
  if (inputs.envFile) sources.push(["env-file", environment(await jsonFile(inputs.envFile, "Environment", deps))]);
  const prefixed: Record<string, string> = {};
  for (const [name, value] of Object.entries(deps.environmentVariables)) {
    if (name.startsWith(prefix) && value !== undefined) prefixed[name.slice(prefix.length)] = value;
  }
  if (Object.keys(prefixed).length > 0) sources.push(["step env", environment(prefixed)]);

  let sopsToken = "";
  if (inputs.sopsFile) {
    const decrypted = record(await deps.decryptSops(inputs.sopsFile, required(inputs.sopsAgeKey, "sops-age-key")), "SOPS file");
    const tokenKey = required(inputs.sopsTokenKey, "sops-token-key");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenKey)) throw new Error("sops-token-key is invalid");
    const candidate = decrypted[tokenKey];
    if (candidate !== undefined && typeof candidate !== "string") throw new Error("SOPS token must be a string");
    sopsToken = candidate ?? "";
    const included = csv(inputs.sopsEnvKeys);
    for (const key of included) {
      if (key === tokenKey || !(key in decrypted)) throw new Error(`sops-env-keys contains unavailable environment key ${key}`);
    }
    const entries = Object.fromEntries(Object.entries(decrypted).filter(([key]) =>
      key !== tokenKey && (included.length === 0 || included.includes(key))));
    sources.push(["sops-file", environment(entries)]);
  } else if (inputs.sopsAgeKey || inputs.sopsEnvKeys) {
    throw new Error("sops-age-key and sops-env-keys require sops-file");
  }

  const seen = new Map<string, string>();
  const entries: JsonRecord[] = [];
  for (const [source, values] of sources) {
    for (const entry of values) {
      const key = entry.key as string;
      const previous = seen.get(key);
      if (previous) throw new Error(`Environment key ${key} appears in both ${previous} and ${source}`);
      seen.set(key, source);
      entries.push(entry);
      if (entry.value) deps.mask(entry.value as string);
    }
  }
  if (sopsToken) deps.mask(sopsToken);
  for (const key of csv(inputs.requiredEnvKeys)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid required environment key ${key}`);
    if (!entries.some((entry) => entry.key === key && Boolean(entry.value))) {
      throw new Error(`Required environment variable ${key} is missing or empty`);
    }
  }
  return { entries, sopsToken };
}

function pathPart(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} contains an invalid identifier`);
  return value;
}

function imageTag(value: string): string {
  if (/^sha256:[a-f0-9]{64}$/.test(value)) return value.replace(":", "-");
  if (!/^[\w][\w.-]{0,127}$/.test(value)) throw new Error("image-tag is invalid");
  return value;
}

class Coolify {
  constructor(
    private readonly root: URL,
    private readonly token: string,
    private readonly deps: Dependencies,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const url = new URL(path.replace(/^\//, ""), this.root);
    let response: Response;
    try {
      response = await this.deps.fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`${method} ${url.pathname} could not reach Coolify`);
    }
    let data: unknown = null;
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

  async expect(method: string, path: string, body?: unknown): Promise<unknown> {
    const result = await this.request(method, path, body);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`${method} ${path} failed with HTTP ${result.status}`);
    }
    return result.data;
  }
}

function deploymentList(value: unknown): Deployment[] {
  const body = record(value, "Deploy response");
  if (!Array.isArray(body.deployments) || body.deployments.length === 0) {
    throw new Error("Coolify returned no deployments");
  }
  return body.deployments.map((value, index) => {
    const entry = record(value, `Deployment ${index + 1}`);
    if (typeof entry.resource_uuid !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.resource_uuid)) {
      throw new Error(`Deployment ${index + 1} has no resource UUID`);
    }
    if (entry.deployment_uuid !== undefined && entry.deployment_uuid !== null && entry.deployment_uuid !== "" &&
      (typeof entry.deployment_uuid !== "string" || !/^[A-Za-z0-9_-]+$/.test(entry.deployment_uuid))) {
      throw new Error(`Deployment ${index + 1} has an invalid deployment UUID`);
    }
    return {
      resource_uuid: entry.resource_uuid,
      deployment_uuid: entry.deployment_uuid || undefined,
      message: typeof entry.message === "string" ? entry.message : undefined,
    };
  });
}

async function resourceType(
  requested: string,
  uuid: string,
  client: Coolify,
): Promise<ResourceType> {
  if (requested === "application" || requested === "service") return requested;
  if (requested !== "auto") throw new Error("resource-type must be application, service, or auto");
  const application = await client.request("GET", `applications/${uuid}`);
  if (application.status >= 200 && application.status < 300) return "application";
  if (application.status !== 404) throw new Error(`GET applications/${uuid} failed with HTTP ${application.status}`);
  const service = await client.request("GET", `services/${uuid}`);
  if (service.status >= 200 && service.status < 300) return "service";
  throw new Error(`Could not find application or service ${uuid} (service lookup HTTP ${service.status})`);
}

export async function deploy(inputs: Inputs, deps: Dependencies = defaultDependencies): Promise<Result> {
  const uuids = csv(inputs.uuids).map((uuid) => pathPart(uuid, "uuids"));
  const tags = csv(inputs.tags);
  const applicationRequested = Boolean(inputs.applicationSlug || inputs.applicationFile);
  if (!applicationRequested && (inputs.project || inputs.server || inputs.destination || inputs.environment || inputs.createIfMissing)) {
    throw new Error("project, server, destination, environment, and create-if-missing require application-slug or application-file");
  }
  const application = applicationRequested
    ? applicationSpec(inputs.applicationFile ? await jsonFile(inputs.applicationFile, "Application", deps) : {}, {
      slug: inputs.applicationSlug,
      project: inputs.project,
      server: inputs.server,
      destination: inputs.destination,
      environment: inputs.environment,
      createIfMissing: inputs.createIfMissing,
    })
    : undefined;
  if (Number(uuids.length > 0) + Number(tags.length > 0) + Number(Boolean(application)) !== 1) {
    throw new Error("Set exactly one of uuids, tags, or application-slug/application-file");
  }
  const mutatingRequested = Boolean(application || inputs.envFile || inputs.sopsFile || inputs.pruneEnvKeys || inputs.patchFile || inputs.imageTag ||
    Object.keys(deps.environmentVariables).some((name) => name.startsWith(inputs.envPrefix)));
  if (mutatingRequested && !application && (uuids.length !== 1 || tags.length > 0)) {
    throw new Error("Environment and configuration updates require exactly one resource UUID or application-file");
  }
  const { entries: envs, sopsToken } = await environmentSources(inputs, deps);
  const mutating = Boolean(application || envs.length || inputs.pruneEnvKeys || inputs.patchFile || inputs.imageTag);
  const force = boolean(inputs.force, "force");
  const wait = boolean(inputs.wait, "wait");
  const timeout = positiveInteger(inputs.timeoutSeconds, "timeout-seconds", 86_400) * 1_000;
  const interval = positiveInteger(inputs.pollIntervalSeconds, "poll-interval-seconds", 3_600) * 1_000;
  const healthStatus = positiveInteger(inputs.healthStatus, "health-status", 599);
  const healthTimeout = positiveInteger(inputs.healthTimeoutSeconds, "health-timeout-seconds", 86_400) * 1_000;
  if (healthStatus < 100) throw new Error("health-status must be a valid HTTP status code");
  if (inputs.healthUrl && !wait) throw new Error("health-url requires wait: true");
  let healthUrl: URL | undefined;
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
  const prId = inputs.pullRequestId
    ? positiveInteger(inputs.pullRequestId, "pull-request-id", 2_147_483_647)
    : undefined;
  if (prId && tags.length > 0) throw new Error("pull-request-id cannot be used with tags");
  if (inputs.dockerTag && !prId) throw new Error("docker-tag requires pull-request-id");
  if (inputs.imageTag && (prId || inputs.dockerTag)) {
    throw new Error("image-tag cannot be combined with preview deployment options");
  }
  if (inputs.imageTag && !inputs.imageName) throw new Error("image-name is required with image-tag");
  if (inputs.imageName && !inputs.imageTag) throw new Error("image-tag is required with image-name");
  if (application && !inputs.imageTag) throw new Error("application-slug requires image-name and image-tag");
  const token = required(inputs.token || sopsToken, "token");
  deps.mask(token);
  const client = new Coolify(baseUrl(inputs.url), token, deps);

  if (application) {
    const target = await resolveApplication(application, inputs.imageName, imageTag(inputs.imageTag), client);
    uuids.push(target.uuid);
    deps.log(`${target.created ? "Created" : "Found"} application ${application.slug}: ${target.uuid}`);
    await syncPersistentStorages(application, target.uuid, target.created, client, deps.log);
  }

  if (mutating) {
    const uuid = uuids[0]!;
    const kind = application ? "application" : await resourceType(inputs.resourceType, uuid, client);
    const path = `${kind}s/${uuid}`;
    const managed = new Set(csv(inputs.pruneEnvKeys));
    for (const key of managed) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid managed environment key ${key}`);
    }
    const existing = managed.size > 0 ? await client.expect("GET", `${path}/envs`) : undefined;
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error("Coolify returned an invalid environment list");
    }
    const filePatch: JsonRecord = inputs.patchFile
      ? record(await jsonFile(inputs.patchFile, "Patch", deps), "Patch file")
      : {};
    const patch: JsonRecord = { ...application?.update };
    for (const [key, value] of Object.entries(filePatch)) {
      if (key in patch) throw new Error(`Patch field ${key} appears in both application-file and patch-file`);
      patch[key] = value;
    }
    if (inputs.imageTag) {
      if (kind !== "application") throw new Error("image-tag requires an application");
      const application = record(await client.expect("GET", path), "Application response");
      if (application.build_pack !== "dockerimage" || application.docker_registry_image_name !== inputs.imageName) {
        throw new Error("The target is not the expected Docker Image application");
      }
      if (patch.docker_registry_image_tag !== undefined) {
        throw new Error("Set image-tag or docker_registry_image_tag in patch-file, not both");
      }
      patch.docker_registry_image_tag = imageTag(inputs.imageTag);
    }
    if (envs.length > 0) {
      await client.expect("PATCH", `${path}/envs/bulk`, { data: envs });
      deps.log(`Updated ${envs.length} environment variables for ${kind} ${uuid}`);
    }
    if (managed.size > 0 && Array.isArray(existing)) {
      const desired = new Set(envs.filter((entry) => entry.is_preview !== true).map((entry) => entry.key as string));
      for (const value of existing) {
        const entry = record(value, "Existing environment variable");
        if (typeof entry.key !== "string" || !managed.has(entry.key) || desired.has(entry.key) || entry.is_preview === true) continue;
        if (typeof entry.uuid !== "string") throw new Error(`Environment variable ${entry.key} has no UUID`);
        await client.expect("DELETE", `${path}/envs/${pathPart(entry.uuid, "environment UUID")}`);
        deps.log(`Removed managed environment variable ${entry.key}`);
      }
    }

    if (Object.keys(patch).length > 0) {
      await client.expect("PATCH", path, patch);
      deps.log(`Updated ${kind} configuration for ${uuid}`);
    }
  }

  const payload: JsonRecord = { force };
  if (uuids.length > 0) payload.uuid = uuids.join(",");
  if (tags.length > 0) payload.tag = tags.join(",");
  if (prId) payload.pull_request_id = prId;
  if (inputs.dockerTag) payload.docker_tag = inputs.dockerTag;
  const accepted = deploymentList(await client.expect("POST", "deploy", payload));
  deps.onAccepted(accepted);
  for (const entry of accepted) {
    deps.log(`Coolify accepted ${entry.resource_uuid}: ${entry.deployment_uuid || "no deployment UUID"}`);
  }
  if (!wait) return { deployments: accepted, status: "accepted" };

  const pending = new Set(accepted.map((item) => item.deployment_uuid).filter((id): id is string => Boolean(id)));
  if (pending.size === 0) {
    if (healthUrl) throw new Error("Coolify did not return a deployment UUID; health check cannot identify the new deployment");
    return { deployments: accepted, status: "accepted" };
  }
  const deadline = deps.now() + timeout;
  while (pending.size > 0) {
    if (deps.now() >= deadline) throw new Error(`Timed out waiting for ${pending.size} Coolify deployment(s)`);
    for (const id of [...pending]) {
      const response = record(await client.expect("GET", `deployments/${pathPart(id, "deployment UUID")}`), "Deployment status");
      if (response.status === "finished") {
        pending.delete(id);
        deps.log(`Coolify deployment ${id} finished`);
      } else if (response.status !== "queued" && response.status !== "in_progress") {
        throw new Error(`Coolify deployment ${id} ended with status ${String(response.status)}`);
      }
    }
    if (pending.size > 0) await deps.sleep(Math.min(interval, Math.max(0, deadline - deps.now())));
  }
  if (healthUrl) {
    const healthDeadline = deps.now() + healthTimeout;
    let healthy = false;
    while (deps.now() < healthDeadline) {
      try {
        const response = await deps.fetch(healthUrl, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (response.status === healthStatus) {
          healthy = true;
          break;
        }
      } catch {
        // An unavailable endpoint can become ready during the health window.
      }
      await deps.sleep(Math.min(interval, Math.max(0, healthDeadline - deps.now())));
    }
    if (!healthy) throw new Error("The health URL did not return the expected status before the timeout");
    deps.log("Health check passed");
  }
  return {
    deployments: accepted,
    status: accepted.some((item) => !item.deployment_uuid) ? "partially-observed" : "finished",
  };
}
