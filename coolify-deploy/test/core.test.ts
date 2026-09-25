import { describe, expect, test } from "bun:test";
import { deploy, type Dependencies, type Inputs } from "../src/core.ts";

function inputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    url: "https://coolify.example",
    token: "coolify-secret",
    uuids: "resource123",
    tags: "",
    resourceType: "application",
    applicationSlug: "",
    project: "",
    server: "",
    destination: "",
    environment: "",
    createIfMissing: "",
    applicationFile: "",
    envFile: "",
    envPrefix: "COOLIFY_ENV_",
    requiredEnvKeys: "",
    sopsFile: "",
    sopsAgeKey: "",
    sopsTokenKey: "COOLIFY_API_TOKEN",
    sopsEnvKeys: "",
    pruneEnvKeys: "",
    patchFile: "",
    imageName: "",
    imageTag: "",
    force: "false",
    pullRequestId: "",
    dockerTag: "",
    wait: "true",
    timeoutSeconds: "1200",
    pollIntervalSeconds: "1",
    healthUrl: "",
    healthStatus: "200",
    healthTimeoutSeconds: "360",
    ...overrides,
  };
}

function fixture(
  responses: Array<[number, unknown]>,
  files: Record<string, string> = {},
  environmentVariables: NodeJS.ProcessEnv = {},
  decrypted: unknown = {},
) {
  const calls: Array<{ method: string; url: string; token: string; body: unknown }> = [];
  const logs: string[] = [];
  const accepted: unknown[] = [];
  const masked: string[] = [];
  const deps: Dependencies = {
    fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
      const [status, payload] = responses.shift() ?? [500, { message: "Unexpected request" }];
      calls.push({
        method: init?.method ?? "GET",
        url: String(url),
        token: String(new Headers(init?.headers).get("Authorization")),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(status === 204 ? null : JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
    sleep: async () => {},
    now: () => 0,
    readFile: async (path) => {
      if (!(path in files)) throw new Error("Missing fixture file");
      return files[path]!;
    },
    environmentVariables,
    decryptSops: async () => decrypted,
    mask: (value) => masked.push(value),
    log: (message) => logs.push(message),
    onAccepted: (deployments) => accepted.push(deployments),
  };
  return { deps, calls, logs, accepted, masked };
}

describe("Coolify deployment", () => {
  test("syncs secrets, pins a Docker Image digest, and waits for completion", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const f = fixture([
      [200, { uuid: "resource123", build_pack: "dockerimage", docker_registry_image_name: "ghcr.io/org/app" }],
      [201, []],
      [200, { uuid: "resource123" }],
      [200, { deployments: [{ resource_uuid: "resource123", deployment_uuid: "deployment123" }] }],
      [200, { status: "queued" }],
      [200, { status: "finished" }],
    ], { "/tmp/env.json": JSON.stringify({ API_KEY: "private-value" }) });
    const result = await deploy(inputs({ envFile: "/tmp/env.json", imageName: "ghcr.io/org/app", imageTag: digest }), f.deps);

    expect(result.status).toBe("finished");
    expect(f.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /api/v1/applications/resource123",
      "PATCH /api/v1/applications/resource123/envs/bulk",
      "PATCH /api/v1/applications/resource123",
      "POST /api/v1/deploy",
      "GET /api/v1/deployments/deployment123",
      "GET /api/v1/deployments/deployment123",
    ]);
    expect(f.calls.map((call) => call.token)).toEqual([
      "Bearer coolify-secret", "Bearer coolify-secret", "Bearer coolify-secret",
      "Bearer coolify-secret", "Bearer coolify-secret", "Bearer coolify-secret",
    ]);
    expect(f.masked).toContain("coolify-secret");
    expect(f.calls[1]?.body).toEqual({ data: [{
      key: "API_KEY", value: "private-value", is_runtime: true, is_buildtime: false,
      is_preview: false, is_literal: true, is_shown_once: true,
    }] });
    expect(f.calls[2]?.body).toEqual({ docker_registry_image_tag: `sha256-${"a".repeat(64)}` });
    expect(JSON.stringify(f.logs)).not.toContain("private-value");
    expect(f.accepted).toHaveLength(1);
  });

  test("deploys multiple tagged resources with a deploy-only token", async () => {
    const f = fixture([[200, { deployments: [
      { resource_uuid: "one", deployment_uuid: "deploy1" },
      { resource_uuid: "two", deployment_uuid: "deploy2" },
    ] }]]);
    const result = await deploy(inputs({
      token: "deploy-only-secret", uuids: "", tags: "frontend, backend", wait: "false", force: "true",
    }), f.deps);
    expect(result.status).toBe("accepted");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.token).toBe("Bearer deploy-only-secret");
    expect(f.calls[0]?.body).toEqual({ tag: "frontend,backend", force: true });
  });

  test("lets Coolify report insufficient token permissions", async () => {
    const f = fixture([[403, { message: "Forbidden" }]], {
      "/tmp/env.json": JSON.stringify({ API_KEY: "private-value" }),
    });
    await expect(deploy(inputs({ token: "deploy-only-secret", envFile: "/tmp/env.json" }), f.deps))
      .rejects.toThrow("PATCH applications/resource123/envs/bulk failed with HTTP 403");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.token).toBe("Bearer deploy-only-secret");
    expect(JSON.stringify(f.logs)).not.toContain("private-value");
  });

  test("requires one token before contacting Coolify", async () => {
    const f = fixture([]);
    await expect(deploy(inputs({ token: "" }), f.deps)).rejects.toThrow("token is required");
    expect(f.calls).toHaveLength(0);
  });

  test("detects services and removes only explicitly managed stale variables", async () => {
    const f = fixture([
      [404, { message: "Resource not found" }],
      [200, { uuid: "resource123" }],
      [200, [
        { key: "OLD_KEY", uuid: "old123", is_preview: false },
        { key: "UNRELATED", uuid: "other123", is_preview: false },
        { key: "OLD_KEY", uuid: "preview123", is_preview: true },
      ]],
      [201, []],
      [200, { message: "Environment variable deleted" }],
      [200, { deployments: [{ resource_uuid: "resource123" }] }],
    ], { "/tmp/env.json": JSON.stringify([{ key: "NEW_KEY", value: "secret", is_preview: true }]) });
    const result = await deploy(inputs({
      resourceType: "auto", envFile: "/tmp/env.json", pruneEnvKeys: "OLD_KEY,NEW_KEY",
    }), f.deps);
    expect(result.status).toBe("accepted");
    expect(f.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /api/v1/applications/resource123",
      "GET /api/v1/services/resource123",
      "GET /api/v1/services/resource123/envs",
      "PATCH /api/v1/services/resource123/envs/bulk",
      "DELETE /api/v1/services/resource123/envs/old123",
      "POST /api/v1/deploy",
    ]);
  });

  test("rejects invalid combinations before contacting Coolify", async () => {
    const f = fixture([]);
    await expect(deploy(inputs({ uuids: "", tags: "frontend", envFile: "/tmp/env.json" }), f.deps))
      .rejects.toThrow("exactly one resource UUID");
    await expect(deploy(inputs({ uuids: "", tags: "" }), f.deps))
      .rejects.toThrow("exactly one of uuids, tags, or application-slug/application-file");
    await expect(deploy(inputs({ dockerTag: "preview" }), f.deps))
      .rejects.toThrow("requires pull-request-id");
    expect(f.calls).toHaveLength(0);
  });

  test("fails on a deployment error without exposing environment values", async () => {
    const f = fixture([
      [201, [{ value: "private-value" }]],
      [200, { deployments: [{ resource_uuid: "resource123", deployment_uuid: "deployment123" }] }],
      [200, { status: "failed", logs: "private-value" }],
    ], { "/tmp/env.json": JSON.stringify({ API_KEY: "private-value" }) });
    await expect(deploy(inputs({ envFile: "/tmp/env.json" }), f.deps))
      .rejects.toThrow("deployment123 ended with status failed");
    expect(JSON.stringify(f.logs)).not.toContain("private-value");
  });

  test("applies an application patch and requests a Docker Image preview", async () => {
    const f = fixture([
      [200, { uuid: "resource123" }],
      [200, { deployments: [{ resource_uuid: "resource123", deployment_uuid: "preview123" }] }],
    ], { "/tmp/patch.json": JSON.stringify({ description: "Updated application" }) });
    const result = await deploy(inputs({
      resourceType: "application", patchFile: "/tmp/patch.json", pullRequestId: "42",
      dockerTag: "pr-42", wait: "false",
    }), f.deps);
    expect(result.status).toBe("accepted");
    expect(f.calls[0]?.url).toBe("https://coolify.example/api/v1/applications/resource123");
    expect(f.calls[0]?.body).toEqual({ description: "Updated application" });
    expect(f.calls[1]?.body).toEqual({ uuid: "resource123", force: false, pull_request_id: 42, docker_tag: "pr-42" });
  });

  test("hides a Coolify error body that contains a secret", async () => {
    const f = fixture([[422, { message: "Invalid secret private-value" }]], {
      "/tmp/env.json": JSON.stringify({ API_KEY: "private-value" }),
    });
    await expect(deploy(inputs({ envFile: "/tmp/env.json" }), f.deps))
      .rejects.toThrow("HTTP 422");
    expect(JSON.stringify(f.logs)).not.toContain("private-value");
  });

  test("checks an optional health endpoint after the deployment finishes", async () => {
    const f = fixture([
      [200, { deployments: [{ resource_uuid: "resource123", deployment_uuid: "deployment123" }] }],
      [200, { status: "finished" }],
      [204, null],
    ]);
    const result = await deploy(inputs({
      healthUrl: "https://app.example/ready", healthStatus: "204",
    }), f.deps);
    expect(result.status).toBe("finished");
    expect(f.calls[2]?.url).toBe("https://app.example/ready");
    expect(f.calls[2]?.token).toBe("null");
    expect(f.logs).toContain("Health check passed");
  });

  test("syncs prefixed step variables and validates required secrets before any API call", async () => {
    const f = fixture([
      [201, []],
      [200, { deployments: [{ resource_uuid: "resource123" }] }],
    ], {}, { COOLIFY_ENV_API_KEY: "from-github", COOLIFY_ENV_OPTIONAL: "", UNRELATED: "ignored" });
    const result = await deploy(inputs({ requiredEnvKeys: "API_KEY", wait: "false" }), f.deps);
    expect(result.status).toBe("accepted");
    expect(f.calls[0]?.body).toEqual({ data: [
      { key: "API_KEY", value: "from-github", is_runtime: true, is_buildtime: false, is_preview: false, is_literal: true, is_shown_once: true },
      { key: "OPTIONAL", value: "", is_runtime: true, is_buildtime: false, is_preview: false, is_literal: true, is_shown_once: true },
    ] });
    expect(f.masked).toContain("from-github");
    expect(JSON.stringify(f.logs)).not.toContain("from-github");

    const missing = fixture([], {}, { COOLIFY_ENV_API_KEY: "" });
    await expect(deploy(inputs({ requiredEnvKeys: "API_KEY" }), missing.deps))
      .rejects.toThrow("Required environment variable API_KEY is missing or empty");
    expect(missing.calls).toHaveLength(0);
  });

  test("decrypts SOPS data, uses its API token, and syncs only allowed runtime keys", async () => {
    const f = fixture([
      [201, []],
      [200, { deployments: [{ resource_uuid: "resource123" }] }],
    ], {}, { COOLIFY_ENV_PUBLIC_SETTING: "enabled" }, {
      COOLIFY_API_TOKEN: "sops-token",
      DATABASE_URL: "postgres://secret",
      DO_NOT_SYNC: "excluded",
    });
    const result = await deploy(inputs({
      sopsFile: "deployment/prod.sops.json",
      sopsAgeKey: "age-secret",
      sopsEnvKeys: "DATABASE_URL",
      token: "", wait: "false",
    }), f.deps);
    expect(result.status).toBe("accepted");
    expect(f.calls.map((call) => call.token)).toEqual(["Bearer sops-token", "Bearer sops-token"]);
    expect(f.calls[0]?.body).toEqual({ data: [
      { key: "PUBLIC_SETTING", value: "enabled", is_runtime: true, is_buildtime: false, is_preview: false, is_literal: true, is_shown_once: true },
      { key: "DATABASE_URL", value: "postgres://secret", is_runtime: true, is_buildtime: false, is_preview: false, is_literal: true, is_shown_once: true },
    ] });
    expect(f.masked).toContain("sops-token");
    expect(JSON.stringify(f.logs)).not.toContain("postgres://secret");
  });

  test("rejects duplicate environment sources and missing SOPS keys before API calls", async () => {
    const f = fixture([], { "/tmp/env.json": JSON.stringify({ API_KEY: "file-secret" }) },
      { COOLIFY_ENV_API_KEY: "step-secret" });
    await expect(deploy(inputs({ envFile: "/tmp/env.json" }), f.deps)).rejects.toThrow("appears in both");
    expect(f.calls).toHaveLength(0);

    const sops = fixture([], {}, {}, { COOLIFY_API_TOKEN: "token" });
    await expect(deploy(inputs({ sopsFile: "secrets.sops.json", sopsAgeKey: "age-secret", sopsEnvKeys: "MISSING" }), sops.deps))
      .rejects.toThrow("unavailable environment key MISSING");
    expect(sops.calls).toHaveLength(0);
  });

  test("creates a Docker Image application from its slug, adds storage, then configures and deploys", async () => {
    const spec = {
      create: { autogenerate_domain: false, health_check_enabled: false },
      update: { is_consistent_container_name_enabled: true, stop_grace_period: 300 },
      storages: [{ name: "call-recorder-data", mount_path: "/app/data" }],
    };
    const f = fixture([
      [200, [{ uuid: "project123", name: "syntropika" }]],
      [200, [{ id: 42, name: "production" }]],
      [200, [{ uuid: "server123", name: "ovh1" }]],
      [200, [
        { uuid: "destination123", name: "coolify", server_uuid: "server123" },
        { uuid: "destination456", name: "other", server_uuid: "server123" },
      ]],
      [200, []],
      [201, { uuid: "newapp123" }],
      [201, {}],
      [200, { build_pack: "dockerimage", docker_registry_image_name: "ghcr.io/org/app" }],
      [201, []],
      [200, { uuid: "newapp123" }],
      [200, { deployments: [{ resource_uuid: "newapp123" }] }],
    ], { "/tmp/app.json": JSON.stringify(spec) }, { COOLIFY_ENV_API_KEY: "private-value" });
    const result = await deploy(inputs({
      uuids: "", applicationSlug: "call-recorder-bot", project: "syntropika", server: "ovh1", destination: "coolify",
      environment: "production", createIfMissing: "true", applicationFile: "/tmp/app.json",
      imageName: "ghcr.io/org/app", imageTag: "commit123",
      requiredEnvKeys: "API_KEY", wait: "false",
    }), f.deps);
    expect(result.status).toBe("accepted");
    expect(f.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /api/v1/projects",
      "GET /api/v1/projects/project123/environments",
      "GET /api/v1/servers",
      "GET /api/v1/destinations",
      "GET /api/v1/applications",
      "POST /api/v1/applications/dockerimage",
      "POST /api/v1/applications/newapp123/storages",
      "GET /api/v1/applications/newapp123",
      "PATCH /api/v1/applications/newapp123/envs/bulk",
      "PATCH /api/v1/applications/newapp123",
      "POST /api/v1/deploy",
    ]);
    expect(f.calls[5]?.body).toEqual({
      autogenerate_domain: false, health_check_enabled: false,
      project_uuid: "project123", server_uuid: "server123", destination_uuid: "destination123", environment_name: "production",
      name: "call-recorder-bot", docker_registry_image_name: "ghcr.io/org/app",
      docker_registry_image_tag: "commit123", instant_deploy: false,
    });
    expect(f.calls[6]?.body).toEqual({ type: "persistent", name: "call-recorder-data", mount_path: "/app/data" });
    expect(f.calls[9]?.body).toEqual({
      is_consistent_container_name_enabled: true, stop_grace_period: 300,
      docker_registry_image_tag: "commit123",
    });
    expect(f.calls[10]?.body).toEqual({ uuid: "newapp123", force: false });
    expect(JSON.stringify(f.logs)).not.toContain("private-value");
  });

  test("reuses an application by slug within its project environment without recreating storage", async () => {
    const spec = { storages: [{ name: "call-recorder-data", mount_path: "/app/data" }] };
    const f = fixture([
      [200, [{ uuid: "project123", name: "syntropika" }]],
      [200, [{ id: 42, name: "production" }]],
      [200, [{ uuid: "server123", name: "ovh1" }]],
      [200, [
        { uuid: "destination123", name: "coolify", server_uuid: "server123" },
        { uuid: "destination456", name: "other", server_uuid: "server123" },
      ]],
      [200, [
        { uuid: "elsewhere123", name: "call-recorder-bot", environment_id: 42,
          build_pack: "dockerimage", docker_registry_image_name: "ghcr.io/org/app" },
        { uuid: "existing123", name: "call-recorder-bot", environment_id: 42,
          build_pack: "dockerimage", docker_registry_image_name: "ghcr.io/org/app" },
      ]],
      [200, [{ is_primary: true, server_uuid: "server123", uuid: "destination456" }]],
      [200, [{ is_primary: true, server_uuid: "server123", uuid: "destination123" }]],
      [200, { persistent_storages: [{ name: "call-recorder-data", mount_path: "/app/data" }] }],
      [200, { build_pack: "dockerimage", docker_registry_image_name: "ghcr.io/org/app" }],
      [200, { uuid: "existing123" }],
      [200, { deployments: [{ resource_uuid: "existing123" }] }],
    ], { "/tmp/app.json": JSON.stringify(spec) });
    const result = await deploy(inputs({
      uuids: "", applicationSlug: "call-recorder-bot", project: "syntropika", server: "ovh1", destination: "coolify",
      environment: "production", applicationFile: "/tmp/app.json",
      imageName: "ghcr.io/org/app", imageTag: "commit456", wait: "false",
    }), f.deps);
    expect(result.status).toBe("accepted");
    expect(f.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /api/v1/projects",
      "GET /api/v1/projects/project123/environments",
      "GET /api/v1/servers",
      "GET /api/v1/destinations",
      "GET /api/v1/applications",
      "GET /api/v1/applications/elsewhere123/destinations",
      "GET /api/v1/applications/existing123/destinations",
      "GET /api/v1/applications/existing123/storages",
      "GET /api/v1/applications/existing123",
      "PATCH /api/v1/applications/existing123",
      "POST /api/v1/deploy",
    ]);
  });

  test("refuses ambiguous application slugs before changing Coolify", async () => {
    const f = fixture([
      [200, [{ uuid: "project123", name: "syntropika" }]],
      [200, [{ id: 42, name: "production" }]],
      [200, [{ uuid: "server123", name: "ovh1" }]],
      [200, [
        { uuid: "one", name: "call-recorder-bot", environment_id: 42 },
        { uuid: "two", name: "call-recorder-bot", environment_id: 42 },
      ]],
      [200, [{ is_primary: true, server_uuid: "server123" }]],
      [200, [{ is_primary: true, server_uuid: "server123" }]],
    ]);
    await expect(deploy(inputs({
      uuids: "", applicationSlug: "call-recorder-bot", project: "syntropika", server: "ovh1",
      imageName: "ghcr.io/org/app", imageTag: "commit123",
    }), f.deps)).rejects.toThrow("ambiguous");
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });

  test("does not create an application when required runtime secrets are missing", async () => {
    const f = fixture([]);
    await expect(deploy(inputs({
      uuids: "", applicationSlug: "call-recorder-bot", project: "syntropika", server: "ovh1",
      imageName: "ghcr.io/org/app", imageTag: "commit123",
      requiredEnvKeys: "DISCORD_TOKEN",
    }), f.deps)).rejects.toThrow("Required environment variable DISCORD_TOKEN is missing or empty");
    expect(f.calls).toHaveLength(0);
  });

  test("rejects conflicting target identity between workflow inputs and legacy application files", async () => {
    const f = fixture([], { "/tmp/app.json": JSON.stringify({ slug: "other-bot", project: "syntropika" }) });
    await expect(deploy(inputs({
      uuids: "", applicationSlug: "call-recorder-bot", project: "syntropika",
      applicationFile: "/tmp/app.json", imageName: "ghcr.io/org/app", imageTag: "commit123",
    }), f.deps)).rejects.toThrow("Application slug differs between the workflow and application-file");
    expect(f.calls).toHaveLength(0);
  });

  test("does not deploy when an existing persistent volume conflicts", async () => {
    const spec = { storages: [{ name: "call-recorder-data", mount_path: "/app/data" }] };
    const f = fixture([
      [200, [{ uuid: "project123", name: "syntropika" }]],
      [200, [{ id: 42, name: "production" }]],
      [200, [{ uuid: "server123", name: "ovh1" }]],
      [200, [{ uuid: "existing123", name: "call-recorder-bot", environment_id: 42,
        build_pack: "dockerimage", docker_registry_image_name: "ghcr.io/org/app" }]],
      [200, [{ is_primary: true, server_uuid: "server123" }]],
      [200, { persistent_storages: [{ name: "call-recorder-data", mount_path: "/wrong" }] }],
    ], { "/tmp/app.json": JSON.stringify(spec) });
    await expect(deploy(inputs({
      uuids: "", applicationSlug: "call-recorder-bot", project: "syntropika", server: "ovh1",
      applicationFile: "/tmp/app.json", imageName: "ghcr.io/org/app", imageTag: "commit123",
    }), f.deps)).rejects.toThrow("conflicts with an existing storage");
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
});
