import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const version = "3.13.3";
const checksums: Record<string, string> = {
  "linux.amd64": "e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b",
  "linux.arm64": "53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77",
  "darwin.amd64": "42162d5cef10b74fcf80a045a70e658d7ce6e63d6ea1be6f347e44015714468d",
  "darwin.arm64": "b97c0d434aab577dc40310e8d22ff9e45eef4c80638ab978daae9b4681c59286",
};

export async function decryptSops(path: string, ageKey: string): Promise<unknown> {
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
  const platform = `${process.platform}.${arch}`;
  const expected = checksums[platform];
  if (!expected) throw new Error("SOPS decryption is supported on Linux and macOS x64/arm64 runners");

  const directory = await mkdtemp(join(tmpdir(), "coolify-sops-"));
  try {
    const filename = `sops-v${version}.${platform}`;
    let binary: Buffer;
    try {
      const response = await fetch(`https://github.com/getsops/sops/releases/download/v${version}/${filename}`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error("Download failed");
      binary = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new Error(`Could not download SOPS v${version}`);
    }
    if (createHash("sha256").update(binary).digest("hex") !== expected) {
      throw new Error("SOPS binary checksum verification failed");
    }
    const executable = join(directory, "sops");
    await writeFile(executable, binary, { mode: 0o700 });
    let stdout: string;
    try {
      ({ stdout } = await run(executable, ["decrypt", "--output-type", "json", path], {
        env: { ...process.env, SOPS_AGE_KEY: ageKey },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
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
