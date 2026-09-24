import { describe, expect, test } from "bun:test";
import { deploy, type Dependencies, type Inputs } from "../src/core.ts";

function inputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    url: "https://coolify.example",
    deployToken: "deploy-secret",
    readToken: "read-secret",
    writeToken: "write-secret",
    uuids: "resource123",
    tags: "",
    resourceType: "application",
    envFile: "",
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

function fixture(responses: Array<[number, unknown]>, files: Record<string, string> = {}) {
  const calls: Array<{ method: string; url: string; token: string; body: unknown }> = [];
  const logs: string[] = [];
  const accepted: unknown[] = [];
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
    log: (message) => logs.push(message),
    onAccepted: (deployments) => accepted.push(deployments),
  };
  return { deps, calls, logs, accepted };
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
      "Bearer read-secret", "Bearer write-secret", "Bearer write-secret",
      "Bearer deploy-secret", "Bearer read-secret", "Bearer read-secret",
    ]);
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
      uuids: "", tags: "frontend, backend", readToken: "", writeToken: "", wait: "false", force: "true",
    }), f.deps);
    expect(result.status).toBe("accepted");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.body).toEqual({ tag: "frontend,backend", force: true });
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
      .rejects.toThrow("exactly one of uuids or tags");
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
});
