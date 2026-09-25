import { appendFileSync } from "node:fs";
import { deploy, type Deployment, type Inputs } from "./core.ts";
import { decryptSops } from "./sops.ts";

function input(name: string, fallback = ""): string {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? fallback;
}

function output(name: string, value: string): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(path, `${name}=${value}\n`);
}

function accepted(deployments: Deployment[]): void {
  output("deployments", JSON.stringify(deployments));
  output("deployment-uuids", deployments.map((item) => item.deployment_uuid).filter(Boolean).join(","));
}

const inputs: Inputs = {
  url: input("url"),
  token: input("token"),
  uuids: input("uuids"),
  tags: input("tags"),
  resourceType: input("resource-type", "auto"),
  applicationSlug: input("application-slug"),
  project: input("project"),
  server: input("server"),
  environment: input("environment"),
  createIfMissing: input("create-if-missing"),
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
  healthTimeoutSeconds: input("health-timeout-seconds", "360"),
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
    onAccepted: accepted,
  });
  output("status", result.status);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error(`::error::${message.replace(/[\r\n]/g, " ")}`);
  process.exitCode = 1;
}
