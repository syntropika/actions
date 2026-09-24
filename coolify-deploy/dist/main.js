import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// coolify-deploy/src/main.ts
import { appendFileSync } from "node:fs";

// coolify-deploy/src/core.ts
import { readFile } from "node:fs/promises";

// coolify-deploy/src/sops.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
var run = promisify(execFile);
var version = "3.13.3";
var checksums = {
  "linux.amd64": "e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b",
  "linux.arm64": "53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77",
  "darwin.amd64": "42162d5cef10b74fcf80a045a70e658d7ce6e63d6ea1be6f347e44015714468d",
  "darwin.arm64": "b97c0d434aab577dc40310e8d22ff9e45eef4c80638ab978daae9b4681c59286"
};
async function decryptSops(path, ageKey) {
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
  const platform = `${process.platform}.${arch}`;
  const expected = checksums[platform];
  if (!expected)
    throw new Error("SOPS decryption is supported on Linux and macOS x64/arm64 runners");
  const directory = await mkdtemp(join(tmpdir(), "coolify-sops-"));
  try {
    const filename = `sops-v${version}.${platform}`;
    let binary;
    try {
      const response = await fetch(`https://github.com/getsops/sops/releases/download/v${version}/${filename}`, {
        signal: AbortSignal.timeout(60000)
      });
      if (!response.ok)
        throw new Error("Download failed");
      binary = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new Error(`Could not download SOPS v${version}`);
    }
    if (createHash("sha256").update(binary).digest("hex") !== expected) {
      throw new Error("SOPS binary checksum verification failed");
    }
    const executable = join(directory, "sops");
    await writeFile(executable, binary, { mode: 448 });
    let stdout;
    try {
      ({ stdout } = await run(executable, ["decrypt", "--output-type", "json", path], {
        env: { ...process.env, SOPS_AGE_KEY: ageKey },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120000
      }));
    } catch {
      throw new Error("Could not decrypt SOPS file; check its path and AGE key");
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error("Decrypted SOPS file must contain valid JSON");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// coolify-deploy/src/application.ts
function object(value, context) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value;
}
function list(value, context) {
  if (!Array.isArray(value))
    throw new Error(`${context} must be a JSON array`);
  return value.map((entry, index) => object(entry, `${context} entry ${index + 1}`));
}
function string(value, context) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${context} must be a nonempty string`);
  return value.trim();
}
function identifier(value, context) {
  const result = string(value, context);
  if (!/^[A-Za-z0-9_-]+$/.test(result))
    throw new Error(`${context} contains an invalid identifier`);
  return result;
}
function options(value, context, forbidden) {
  if (value === undefined)
    return {};
  const result = object(value, context);
  for (const key of forbidden) {
    if (key in result)
      throw new Error(`${context} must not set ${key}`);
  }
  return result;
}
function applicationSpec(value) {
  const input = object(value, "Application file");
  const allowed = new Set(["slug", "project", "server", "environment", "create_if_missing", "create", "update", "storages"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key))
      throw new Error(`Application file has unsupported field ${key}`);
  }
  const slug = string(input.slug, "Application slug");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new Error("Application slug must use lowercase letters, digits, and hyphens (maximum 63 characters)");
  }
  const createIfMissing = input.create_if_missing ?? true;
  if (typeof createIfMissing !== "boolean")
    throw new Error("create_if_missing must be true or false");
  const reserved = ["project_uuid", "server_uuid", "environment_name", "environment_uuid", "name", "docker_registry_image_name", "docker_registry_image_tag", "instant_deploy"];
  const create = options(input.create, "Application create options", reserved);
  const update = options(input.update, "Application update options", [...reserved, "build_pack"]);
  const storages = input.storages === undefined ? [] : list(input.storages, "Application storages").map((entry, index) => {
    for (const key of Object.keys(entry)) {
      if (key !== "name" && key !== "mount_path")
        throw new Error(`Storage ${index + 1} has unsupported field ${key}`);
    }
    const name = string(entry.name, `Storage ${index + 1} name`);
    const mount_path = string(entry.mount_path, `Storage ${index + 1} mount_path`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
      throw new Error(`Storage ${index + 1} has an invalid volume name`);
    if (!mount_path.startsWith("/") || mount_path.includes(".."))
      throw new Error(`Storage ${index + 1} mount_path must be an absolute container path`);
    return { name, mount_path };
  });
  const names = new Set;
  const paths = new Set;
  for (const storage of storages) {
    if (names.has(storage.name) || paths.has(storage.mount_path))
      throw new Error("Application storages contain duplicate names or mount paths");
    names.add(storage.name);
    paths.add(storage.mount_path);
  }
  return {
    slug,
    project: input.project === undefined ? "" : string(input.project, "Application project"),
    server: input.server === undefined ? "" : string(input.server, "Application server"),
    environment: input.environment === undefined ? "production" : string(input.environment, "Application environment"),
    create_if_missing: createIfMissing,
    create,
    update,
    storages
  };
}
function select(items, selector, context) {
  const matches = selector ? items.filter((item) => item.name === selector || item.uuid === selector) : items;
  if (matches.length !== 1) {
    throw new Error(selector ? `Expected exactly one ${context} named ${selector}; found ${matches.length}` : `Specify ${context} because Coolify returned ${items.length} candidates`);
  }
  return matches[0];
}
async function resolveApplication(spec, imageName, imageTag, api, readToken, writeToken) {
  const projects = list(await api.expect("GET", "projects", readToken), "Coolify projects");
  const project = select(projects, spec.project, "project");
  const projectUuid = identifier(project.uuid, "Project UUID");
  const environments = list(await api.expect("GET", `projects/${projectUuid}/environments`, readToken), "Coolify environments");
  const environment = select(environments, spec.environment, "environment");
  if (typeof environment.id !== "number")
    throw new Error("Coolify environment has no numeric ID");
  const servers = list(await api.expect("GET", "servers", readToken), "Coolify servers");
  const server = select(servers, spec.server, "server");
  const serverUuid = identifier(server.uuid, "Server UUID");
  const applications = list(await api.expect("GET", "applications", readToken), "Coolify applications");
  const candidates = applications.filter((item) => item.name === spec.slug && item.environment_id === environment.id);
  const matches = [];
  for (const candidate of candidates) {
    const uuid = identifier(candidate.uuid, "Application UUID");
    const destinations = list(await api.expect("GET", `applications/${uuid}/destinations`, readToken), "Application destinations");
    const primary = destinations.filter((destination) => destination.is_primary === true);
    if (primary.length !== 1 || typeof primary[0]?.server_uuid !== "string") {
      throw new Error(`Application ${uuid} has no identifiable primary server`);
    }
    if (primary[0].server_uuid === serverUuid)
      matches.push(candidate);
  }
  if (matches.length > 1)
    throw new Error(`Application slug ${spec.slug} is ambiguous in environment ${spec.environment}`);
  if (matches.length === 1) {
    const application = matches[0];
    if (application.build_pack !== "dockerimage" || application.docker_registry_image_name !== imageName) {
      throw new Error(`Application slug ${spec.slug} exists but is not the expected Docker Image application`);
    }
    return { uuid: identifier(application.uuid, "Application UUID"), created: false };
  }
  if (!spec.create_if_missing)
    throw new Error(`Application slug ${spec.slug} was not found`);
  const created = object(await api.expect("POST", "applications/dockerimage", writeToken, {
    ...spec.create,
    project_uuid: projectUuid,
    server_uuid: serverUuid,
    environment_name: spec.environment,
    name: spec.slug,
    docker_registry_image_name: imageName,
    docker_registry_image_tag: imageTag,
    instant_deploy: false
  }), "Created application");
  return { uuid: identifier(created.uuid, "Created application UUID"), created: true };
}
async function syncPersistentStorages(spec, uuid, created, api, readToken, writeToken, log) {
  if (spec.storages.length === 0)
    return;
  const existing = created ? [] : list(object(await api.expect("GET", `applications/${uuid}/storages`, readToken), "Coolify storages").persistent_storages, "Coolify persistent storages");
  for (const storage of spec.storages) {
    const matching = existing.filter((entry) => entry.name === storage.name || entry.mount_path === storage.mount_path);
    if (matching.length > 1 || matching.some((entry) => entry.name !== storage.name || entry.mount_path !== storage.mount_path)) {
      throw new Error(`Persistent storage ${storage.name} conflicts with an existing storage`);
    }
    if (matching.length === 0) {
      await api.expect("POST", `applications/${uuid}/storages`, writeToken, { type: "persistent", ...storage });
      log(`Created persistent storage ${storage.name} for application ${uuid}`);
    }
  }
}

// coolify-deploy/src/core.ts
var defaultDependencies = {
  fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: Date.now,
  readFile: (path) => readFile(path, "utf8"),
  environmentVariables: process.env,
  decryptSops,
  mask: (value) => console.log(`::add-mask::${value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`),
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
async function environmentSources(inputs, deps) {
  const prefix = required(inputs.envPrefix, "env-prefix");
  if (!/^[A-Za-z_][A-Za-z0-9_]*_$/.test(prefix)) {
    throw new Error("env-prefix must be an environment variable prefix ending in underscore");
  }
  const sources = [];
  if (inputs.envFile)
    sources.push(["env-file", environment(await jsonFile(inputs.envFile, "Environment", deps))]);
  const prefixed = {};
  for (const [name, value] of Object.entries(deps.environmentVariables)) {
    if (name.startsWith(prefix) && value !== undefined)
      prefixed[name.slice(prefix.length)] = value;
  }
  if (Object.keys(prefixed).length > 0)
    sources.push(["step env", environment(prefixed)]);
  let sopsToken = "";
  if (inputs.sopsFile) {
    const decrypted = record(await deps.decryptSops(inputs.sopsFile, required(inputs.sopsAgeKey, "sops-age-key")), "SOPS file");
    const tokenKey = required(inputs.sopsTokenKey, "sops-token-key");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenKey))
      throw new Error("sops-token-key is invalid");
    const candidate = decrypted[tokenKey];
    if (candidate !== undefined && typeof candidate !== "string")
      throw new Error("SOPS token must be a string");
    sopsToken = candidate ?? "";
    const included = csv(inputs.sopsEnvKeys);
    for (const key of included) {
      if (key === tokenKey || !(key in decrypted))
        throw new Error(`sops-env-keys contains unavailable environment key ${key}`);
    }
    const entries2 = Object.fromEntries(Object.entries(decrypted).filter(([key]) => key !== tokenKey && (included.length === 0 || included.includes(key))));
    sources.push(["sops-file", environment(entries2)]);
  } else if (inputs.sopsAgeKey || inputs.sopsEnvKeys) {
    throw new Error("sops-age-key and sops-env-keys require sops-file");
  }
  const seen = new Map;
  const entries = [];
  for (const [source, values] of sources) {
    for (const entry of values) {
      const key = entry.key;
      const previous = seen.get(key);
      if (previous)
        throw new Error(`Environment key ${key} appears in both ${previous} and ${source}`);
      seen.set(key, source);
      entries.push(entry);
      if (entry.value)
        deps.mask(entry.value);
    }
  }
  if (sopsToken)
    deps.mask(sopsToken);
  for (const key of csv(inputs.requiredEnvKeys)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error(`Invalid required environment key ${key}`);
    if (!entries.some((entry) => entry.key === key && Boolean(entry.value))) {
      throw new Error(`Required environment variable ${key} is missing or empty`);
    }
  }
  return { entries, sopsToken };
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
  const application = inputs.applicationFile ? applicationSpec(await jsonFile(inputs.applicationFile, "Application", deps)) : undefined;
  if (Number(uuids.length > 0) + Number(tags.length > 0) + Number(Boolean(application)) !== 1) {
    throw new Error("Set exactly one of uuids, tags, or application-file");
  }
  const mutatingRequested = Boolean(application || inputs.envFile || inputs.sopsFile || inputs.pruneEnvKeys || inputs.patchFile || inputs.imageTag || Object.keys(deps.environmentVariables).some((name) => name.startsWith(inputs.envPrefix)));
  if (mutatingRequested && !application && (uuids.length !== 1 || tags.length > 0)) {
    throw new Error("Environment and configuration updates require exactly one resource UUID or application-file");
  }
  const { entries: envs, sopsToken } = await environmentSources(inputs, deps);
  const mutating = Boolean(application || envs.length || inputs.pruneEnvKeys || inputs.patchFile || inputs.imageTag);
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
  if (application && !inputs.imageTag)
    throw new Error("application-file requires image-name and image-tag");
  const writeToken = inputs.writeToken || sopsToken;
  const readToken = inputs.readToken || writeToken;
  if (mutating && !writeToken)
    throw new Error("write-token is required for configuration updates");
  if (wait && !readToken)
    throw new Error("read-token is required when wait is true");
  const token = required(inputs.deployToken || sopsToken, "deploy-token");
  const client = new Coolify(baseUrl(inputs.url), deps);
  if (application) {
    const target = await resolveApplication(application, inputs.imageName, imageTag(inputs.imageTag), client, readToken, writeToken);
    uuids.push(target.uuid);
    deps.log(`${target.created ? "Created" : "Found"} application ${application.slug}: ${target.uuid}`);
    await syncPersistentStorages(application, target.uuid, target.created, client, readToken, writeToken, deps.log);
  }
  if (mutating) {
    const uuid = uuids[0];
    const kind = application ? "application" : await resourceType(inputs.resourceType, uuid, client, readToken);
    const path = `${kind}s/${uuid}`;
    const managed = new Set(csv(inputs.pruneEnvKeys));
    for (const key of managed) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        throw new Error(`Invalid managed environment key ${key}`);
    }
    const existing = managed.size > 0 ? await client.expect("GET", `${path}/envs`, readToken) : undefined;
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error("Coolify returned an invalid environment list");
    }
    const filePatch = inputs.patchFile ? record(await jsonFile(inputs.patchFile, "Patch", deps), "Patch file") : {};
    const patch = { ...application?.update };
    for (const [key, value] of Object.entries(filePatch)) {
      if (key in patch)
        throw new Error(`Patch field ${key} appears in both application-file and patch-file`);
      patch[key] = value;
    }
    if (inputs.imageTag) {
      if (kind !== "application")
        throw new Error("image-tag requires an application");
      const application2 = record(await client.expect("GET", path, readToken), "Application response");
      if (application2.build_pack !== "dockerimage" || application2.docker_registry_image_name !== inputs.imageName) {
        throw new Error("The target is not the expected Docker Image application");
      }
      if (patch.docker_registry_image_tag !== undefined) {
        throw new Error("Set image-tag or docker_registry_image_tag in patch-file, not both");
      }
      patch.docker_registry_image_tag = imageTag(inputs.imageTag);
    }
    if (envs.length > 0) {
      await client.expect("PATCH", `${path}/envs/bulk`, writeToken, { data: envs });
      deps.log(`Updated ${envs.length} environment variables for ${kind} ${uuid}`);
    }
    if (managed.size > 0 && Array.isArray(existing)) {
      const desired = new Set(envs.filter((entry) => entry.is_preview !== true).map((entry) => entry.key));
      for (const value of existing) {
        const entry = record(value, "Existing environment variable");
        if (typeof entry.key !== "string" || !managed.has(entry.key) || desired.has(entry.key) || entry.is_preview === true)
          continue;
        if (typeof entry.uuid !== "string")
          throw new Error(`Environment variable ${entry.key} has no UUID`);
        await client.expect("DELETE", `${path}/envs/${pathPart(entry.uuid, "environment UUID")}`, writeToken);
        deps.log(`Removed managed environment variable ${entry.key}`);
      }
    }
    if (Object.keys(patch).length > 0) {
      await client.expect("PATCH", path, writeToken, patch);
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
  applicationFile: input("application-file"),
  envFile: input("env-file"),
  envPrefix: input("env-prefix", "COOLIFY_ENV_"),
  requiredEnvKeys: input("required-env-keys"),
  sopsFile: input("sops-file"),
  sopsAgeKey: input("sops-age-key"),
  sopsTokenKey: input("sops-token-key", "COOLIFY_API_TOKEN"),
  sopsEnvKeys: input("sops-env-keys"),
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
    environmentVariables: process.env,
    decryptSops,
    mask: (value) => console.log(`::add-mask::${value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`),
    log: console.log,
    onAccepted: accepted
  });
  output("status", result.status);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error(`::error::${message.replace(/[\r\n]/g, " ")}`);
  process.exitCode = 1;
}
