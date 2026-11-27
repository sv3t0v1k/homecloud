import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createPublicKey, verify as verifyEd25519 } from "crypto";
import { readFile } from "fs/promises";
import { discoverTestBuild } from "./test-build";
import { readHostTestCandidate } from "./host-test-candidate";
import { isNewerVersion, isVersion, withRetry } from "./versions";

const REPOSITORIES = ["sv3t0v1k/homecloud", "sv3t0v1k/https---github.com-sv3t0v1k-homecloud"];
const APIS = REPOSITORIES.map((repository) => `https://api.github.com/repos/${repository}`);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

type Image = { repository: string; digest: string; revision: string; version: string; platform: string; provenance_verification: { index_digest: string; verified: string } };
type Lock = { format: string; repository: string; tag: string; tag_object: string; commit: string; manifest_sha256: string; deployment_status: string; schema_migrations: string[]; ci: { status: string; run_id: string; attempt: string; url: string }; production_qualification: { format: string; status: string; coverage: string; qualification_profile: string; source_commit: string; ci: { run_id: string; attempt: string } }; images: { backend: Image; frontend: Image } };
type Release = { draft: boolean; prerelease: boolean; tag_name: string; body: string | null; assets: { name: string; url: string }[] };
type Installed = { version: string; gitSha: string; schemaMigrations: string[] };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${asciiJson(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return asciiJson(value);
}

function asciiJson(value: unknown): string {
  const json = JSON.stringify(value);
  let ascii = "";
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    ascii += code > 127 ? `\\u${code.toString(16).padStart(4, "0")}` : json[i];
  }
  return ascii;
}

export function verifiedLock(value: unknown): Lock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lock = value as Lock;
  try {
    if (lock.format !== "homecloud-ci-candidate-v1" || !REPOSITORIES.includes(lock.repository) ||
        !isVersion(lock.tag) || !SHA.test(lock.commit) || !SHA.test(lock.tag_object) || lock.deployment_status !== "NOT_DEPLOYED" ||
        lock.ci.status !== "success" || !/^\d+$/.test(lock.ci.run_id) || !/^\d+$/.test(lock.ci.attempt) ||
        lock.ci.url !== `https://github.com/${lock.repository}/actions/runs/${lock.ci.run_id}` ||
        lock.production_qualification.format !== "homecloud-production-qualification-v2" ||
        lock.production_qualification.status !== "PASS" || lock.production_qualification.coverage !== "COVERED" ||
        lock.production_qualification.qualification_profile !== "release" ||
        lock.production_qualification.source_commit !== lock.commit ||
        lock.production_qualification.ci.run_id !== lock.ci.run_id ||
        lock.production_qualification.ci.attempt !== lock.ci.attempt ||
        !Array.isArray(lock.schema_migrations) || !lock.schema_migrations.length ||
        new Set(lock.schema_migrations).size !== lock.schema_migrations.length ||
        lock.schema_migrations.some((item) => typeof item !== "string" || !/^[A-Za-z0-9]+$/.test(item))) return null;
    for (const role of ["backend", "frontend"] as const) {
      const image = lock.images[role];
      if (image.repository !== `ghcr.io/${lock.repository}/${role}` || !DIGEST.test(image.digest) ||
          image.revision !== lock.commit || image.version !== lock.tag || image.platform !== "linux/amd64" ||
          image.provenance_verification.index_digest !== image.digest ||
          image.provenance_verification.verified !== "DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS") return null;
    }
    const { manifest_sha256, ...body } = lock;
    if (manifest_sha256 !== createHash("sha256").update(canonical(body)).digest("hex")) return null;
    return lock;
  } catch { return null; }
}

async function githubTextOnce(path: string, token: string, accept = "application/vnd.github+json"): Promise<string> {
  const urls = path.startsWith("https://") ? [path] : APIS.map((base) => base + path);
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      let response = await fetch(url, {
        headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        redirect: "manual",
        signal: AbortSignal.timeout(4000),
      });
      if (response.status === 302 && accept === "application/octet-stream") {
        const location = response.headers.get("location");
        if (!location || new URL(location).protocol !== "https:" || !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(new URL(location).hostname)) throw new Error("Unexpected asset redirect");
        response = await fetch(location, { redirect: "manual", signal: AbortSignal.timeout(4000) });
      }
      if (!response.ok || response.status >= 300 || Number(response.headers.get("content-length") || 0) > 2_000_000) throw new Error("GitHub unavailable");
      const body = await response.text();
      if (body.length > 2_000_000) throw new Error("GitHub response too large");
      return body;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("GitHub unavailable");
}

async function githubJsonOnce(path: string, token: string, accept?: string): Promise<unknown> {
  return JSON.parse(await githubTextOnce(path, token, accept));
}

// Медленный или прерывистый канал пользователя не должен сразу давать check_unavailable.
async function githubJson(url: string, token: string, accept?: string): Promise<unknown> {
  return withRetry(() => accept === undefined ? githubJsonOnce(url, token) : githubJsonOnce(url, token, accept));
}

// Точные байты release-lock: подпись проверяется до JSON.parse и любого доверия.
async function githubText(url: string, token: string, accept: string): Promise<string> {
  return withRetry(() => githubTextOnce(url, token, accept));
}

// Ed25519: публичный ключ SPKI DER в base64, подпись 64 байта в base64.
function verifyLockSignature(payload: string, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const signature = Buffer.from(signatureB64.trim(), "base64");
    if (signature.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.from(publicKeyB64.trim(), "base64"), format: "der", type: "spki" });
    return verifyEd25519(null, Buffer.from(payload, "utf8"), key, signature);
  } catch { return false; }
}

async function registryDigestOnce(lock: Lock, role: "backend" | "frontend", token: string, user: string): Promise<boolean> {
  try {
    const scope = `repository:${lock.repository}/${role}:pull`;
    const auth: Record<string, string> = token && user ? { Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` } : {};
    const issued = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`, {
      headers: auth, redirect: "manual", signal: AbortSignal.timeout(4000),
    });
    if (!issued.ok || Number(issued.headers.get("content-length") || 0) > 10_000) return false;
    const grant = await issued.json() as { token?: string };
    if (typeof grant.token !== "string" || grant.token.length > 10_000) return false;
    const digest = lock.images[role].digest;
    const response = await fetch(`https://ghcr.io/v2/${lock.repository}/${role}/manifests/${digest}`, {
      method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${grant.token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" },
    });
    return response.status === 200 && response.headers.get("docker-content-digest") === digest;
  } catch { return false; }
}

async function registryDigest(lock: Lock, role: "backend" | "frontend", token: string, user: string): Promise<boolean> {
  try {
    return await withRetry(() => registryDigestOnce(lock, role, token, user), 2);
  } catch { return false; }
}

function newer(candidate: string, installed: string): boolean {
  return isNewerVersion(candidate, installed);
}

@Injectable()
export class UpdatesService {
  constructor(private readonly config: ConfigService) {}

  isAdmin(userId: number): boolean {
    const id = this.config.get<string>("UPDATE_ADMIN_USER_ID");
    return !!id && /^[1-9]\d*$/.test(id) && Number(id) === userId;
  }

  async check() {
    const path = this.config.get<string>("UPDATE_INSTALLED_LOCK_PATH");
    let installed: Installed | null = null;
    try {
      const lock = path && verifiedLock(JSON.parse(await readFile(path, "utf8")));
      if (lock) installed = { version: lock.tag, gitSha: lock.commit, schemaMigrations: lock.schema_migrations };
    } catch { /* Missing deployment evidence remains unknown. */ }
    try {
      const metadataPath = this.config.get<string>("UPDATE_INSTALLED_METADATA_PATH");
      if (!installed && metadataPath) {
        const value = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
        if (value.format === "homecloud-installed-test-v1" && typeof value.gitSha === "string" && SHA.test(value.gitSha) &&
            value.version === value.gitSha.slice(0, 7) && Array.isArray(value.schemaMigrations) && value.schemaMigrations.length > 0 &&
            value.schemaMigrations.every((item) => typeof item === "string" && /^[A-Za-z0-9]+$/.test(item)) &&
            new Set(value.schemaMigrations).size === value.schemaMigrations.length) {
          installed = value as Installed;
        }
      }
    } catch { /* Missing deployment evidence remains unknown. */ }
    const channel = this.config.get<string>("UPDATE_CHANNEL") === "test" ? "test" : "release";
    const base = { channel, installed: installed ? { version: installed.version, gitSha: installed.gitSha } : null };
    if (!installed) return { ...base, available: null, status: "installed_unknown" };
    try {
      const token = this.config.get<string>("UPDATE_GITHUB_TOKEN") || "";
      if (channel === "test") {
        const candidatePath = this.config.get<string>("UPDATE_TEST_CANDIDATE_PATH");
        const available = candidatePath
          ? await readHostTestCandidate(candidatePath, installed)
          : await discoverTestBuild(installed, token, this.config.get<string>("UPDATE_GITHUB_USER") || "");
        return { ...base, available, status: available ? "available" : "current" };
      }
      const publicKey = this.config.get<string>("UPDATE_RELEASE_PUBLIC_KEY") || "";
      // Без репозиторного ключа релизов подпись не проверить: fail-closed.
      if (!publicKey) return { ...base, available: null, status: "check_unavailable" };
      const releases = await githubJson("/releases?per_page=20", token) as Release[];
      if (!Array.isArray(releases)) throw new Error("Invalid releases");
      for (const release of releases) {
        if (release.draft || !isVersion(release.tag_name) ||
            (isVersion(installed.version) && !newer(release.tag_name, installed.version))) continue;
        const assetUrl = (name: string) => release.assets?.find((item) => item.name === name && APIS.some((base) => item.url.startsWith(`${base}/releases/assets/`) && /^\d+$/.test(item.url.slice(`${base}/releases/assets/`.length))));
        const asset = assetUrl("release-lock.json");
        const signatureAsset = assetUrl("release-lock.json.sig");
        if (!asset || !signatureAsset) continue;
        const lockText = await githubText(asset.url, token, "application/octet-stream");
        const signatureText = await githubText(signatureAsset.url, token, "application/octet-stream");
        if (!verifyLockSignature(lockText, signatureText, publicKey)) continue;
        const lock = verifiedLock(JSON.parse(lockText));
        if (!lock || lock.tag !== release.tag_name || lock.commit === installed.gitSha ||
            canonical([...lock.schema_migrations].sort()) !== canonical([...installed.schemaMigrations].sort())) continue;
        const comparison = await githubJson(`/compare/${installed.gitSha}...${lock.commit}`, token) as { status?: string };
        if (comparison.status !== "ahead") continue;
        const changes = release.body?.match(/(?:^|\n)## Изменения\s*\n([^#]{1,500})/i)?.[1].trim();
        if (!changes) continue;
        const run = await githubJson(`/actions/runs/${lock.ci.run_id}`, token) as { conclusion?: string; head_sha?: string; event?: string; path?: string; run_attempt?: number };
        if (run.conclusion !== "success" || run.head_sha !== lock.commit || run.event !== "workflow_dispatch" ||
            run.path !== ".github/workflows/release.yml" || run.run_attempt !== Number(lock.ci.attempt)) continue;
        const tagRef = await githubJson(`/git/ref/tags/${lock.tag}`, token) as { object?: { sha?: string; type?: string } };
        if (tagRef.object?.type !== "tag" || tagRef.object.sha !== lock.tag_object) continue;
        const tag = await githubJson(`/git/tags/${lock.tag_object}`, token) as { object?: { sha?: string; type?: string } };
        if (tag.object?.type !== "commit" || tag.object.sha !== lock.commit) continue;
        const user = this.config.get<string>("UPDATE_GITHUB_USER") || "";
        if (!(await registryDigest(lock, "backend", token, user)) || !(await registryDigest(lock, "frontend", token, user))) continue;
        return { ...base, status: "available", available: {
          version: lock.tag, gitSha: lock.commit,
          manifestSha256: lock.manifest_sha256,
          backendDigest: lock.images.backend.digest, frontendDigest: lock.images.frontend.digest,
          compatibility: "exact-migrations", changes,
        } };
      }
      return { ...base, available: null, status: "current" };
    } catch {
      return { ...base, available: null, status: "check_unavailable" };
    }
  }
}
