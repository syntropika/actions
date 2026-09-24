type JsonRecord = Record<string, unknown>;

interface Api {
  expect(method: string, path: string, token: string, body?: unknown): Promise<unknown>;
}

export interface PersistentStorage {
  name: string;
  mount_path: string;
}

export interface ApplicationSpec {
  slug: string;
  project: string;
  server: string;
  environment: string;
  create_if_missing: boolean;
  create: JsonRecord;
  update: JsonRecord;
  storages: PersistentStorage[];
}

function object(value: unknown, context: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as JsonRecord;
}

function list(value: unknown, context: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be a JSON array`);
  return value.map((entry, index) => object(entry, `${context} entry ${index + 1}`));
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${context} must be a nonempty string`);
  return value.trim();
}

function identifier(value: unknown, context: string): string {
  const result = string(value, context);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new Error(`${context} contains an invalid identifier`);
  return result;
}

function options(value: unknown, context: string, forbidden: string[]): JsonRecord {
  if (value === undefined) return {};
  const result = object(value, context);
  for (const key of forbidden) {
    if (key in result) throw new Error(`${context} must not set ${key}`);
  }
  return result;
}

export function applicationSpec(value: unknown): ApplicationSpec {
  const input = object(value, "Application file");
  const allowed = new Set(["slug", "project", "server", "environment", "create_if_missing", "create", "update", "storages"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Application file has unsupported field ${key}`);
  }
  const slug = string(input.slug, "Application slug");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new Error("Application slug must use lowercase letters, digits, and hyphens (maximum 63 characters)");
  }
  const createIfMissing = input.create_if_missing ?? true;
  if (typeof createIfMissing !== "boolean") throw new Error("create_if_missing must be true or false");
  const reserved = ["project_uuid", "server_uuid", "environment_name", "environment_uuid", "name", "docker_registry_image_name", "docker_registry_image_tag", "instant_deploy"];
  const create = options(input.create, "Application create options", reserved);
  const update = options(input.update, "Application update options", [...reserved, "build_pack"]);
  const storages = input.storages === undefined ? [] : list(input.storages, "Application storages").map((entry, index) => {
    for (const key of Object.keys(entry)) {
      if (key !== "name" && key !== "mount_path") throw new Error(`Storage ${index + 1} has unsupported field ${key}`);
    }
    const name = string(entry.name, `Storage ${index + 1} name`);
    const mount_path = string(entry.mount_path, `Storage ${index + 1} mount_path`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`Storage ${index + 1} has an invalid volume name`);
    if (!mount_path.startsWith("/") || mount_path.includes("..")) throw new Error(`Storage ${index + 1} mount_path must be an absolute container path`);
    return { name, mount_path };
  });
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const storage of storages) {
    if (names.has(storage.name) || paths.has(storage.mount_path)) throw new Error("Application storages contain duplicate names or mount paths");
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
    storages,
  };
}

function select(items: JsonRecord[], selector: string, context: string): JsonRecord {
  const matches = selector ? items.filter((item) => item.name === selector || item.uuid === selector) : items;
  if (matches.length !== 1) {
    throw new Error(selector
      ? `Expected exactly one ${context} named ${selector}; found ${matches.length}`
      : `Specify ${context} because Coolify returned ${items.length} candidates`);
  }
  return matches[0]!;
}

export async function resolveApplication(
  spec: ApplicationSpec,
  imageName: string,
  imageTag: string,
  api: Api,
  readToken: string,
  writeToken: string,
): Promise<{ uuid: string; created: boolean }> {
  const projects = list(await api.expect("GET", "projects", readToken), "Coolify projects");
  const project = select(projects, spec.project, "project");
  const projectUuid = identifier(project.uuid, "Project UUID");
  const environments = list(await api.expect("GET", `projects/${projectUuid}/environments`, readToken), "Coolify environments");
  const environment = select(environments, spec.environment, "environment");
  if (typeof environment.id !== "number") throw new Error("Coolify environment has no numeric ID");
  const servers = list(await api.expect("GET", "servers", readToken), "Coolify servers");
  const server = select(servers, spec.server, "server");
  const serverUuid = identifier(server.uuid, "Server UUID");
  const applications = list(await api.expect("GET", "applications", readToken), "Coolify applications");
  const candidates = applications.filter((item) => item.name === spec.slug && item.environment_id === environment.id);
  const matches: JsonRecord[] = [];
  for (const candidate of candidates) {
    const uuid = identifier(candidate.uuid, "Application UUID");
    const destinations = list(await api.expect("GET", `applications/${uuid}/destinations`, readToken), "Application destinations");
    const primary = destinations.filter((destination) => destination.is_primary === true);
    if (primary.length !== 1 || typeof primary[0]?.server_uuid !== "string") {
      throw new Error(`Application ${uuid} has no identifiable primary server`);
    }
    if (primary[0].server_uuid === serverUuid) matches.push(candidate);
  }
  if (matches.length > 1) throw new Error(`Application slug ${spec.slug} is ambiguous in environment ${spec.environment}`);
  if (matches.length === 1) {
    const application = matches[0]!;
    if (application.build_pack !== "dockerimage" || application.docker_registry_image_name !== imageName) {
      throw new Error(`Application slug ${spec.slug} exists but is not the expected Docker Image application`);
    }
    return { uuid: identifier(application.uuid, "Application UUID"), created: false };
  }
  if (!spec.create_if_missing) throw new Error(`Application slug ${spec.slug} was not found`);
  const created = object(await api.expect("POST", "applications/dockerimage", writeToken, {
    ...spec.create,
    project_uuid: projectUuid,
    server_uuid: serverUuid,
    environment_name: spec.environment,
    name: spec.slug,
    docker_registry_image_name: imageName,
    docker_registry_image_tag: imageTag,
    instant_deploy: false,
  }), "Created application");
  return { uuid: identifier(created.uuid, "Created application UUID"), created: true };
}

export async function syncPersistentStorages(
  spec: ApplicationSpec,
  uuid: string,
  created: boolean,
  api: Api,
  readToken: string,
  writeToken: string,
  log: (message: string) => void,
): Promise<void> {
  if (spec.storages.length === 0) return;
  const existing = created ? [] : list(
    object(await api.expect("GET", `applications/${uuid}/storages`, readToken), "Coolify storages").persistent_storages,
    "Coolify persistent storages",
  );
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
