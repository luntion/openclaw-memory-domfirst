import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "..");
export const changelogPath = path.join(repoRoot, "CHANGELOG.md");
export const packageJsonPath = path.join(repoRoot, "package.json");
export const packageLockPath = path.join(repoRoot, "package-lock.json");
export const pluginManifestPath = path.join(repoRoot, "openclaw.plugin.json");
export const releaseDir = path.join(repoRoot, "release");

export function run(command, args, options = {}) {
  const invocation = resolveCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const suffix = stderr ? `\n${stderr}` : "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}${suffix}`);
  }

  return options.capture ? result.stdout.trim() : "";
}

export function commandExists(command) {
  const invocation = resolveCommandInvocation(command, ["--version"]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "ignore",
    shell: false,
  });

  return result.status === 0;
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function resolveCommandInvocation(command, args) {
  if (process.platform === "win32" && command === "npm") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return {
      command: comspec,
      args: ["/d", "/s", "/c", "npm", ...args],
    };
  }

  return {
    command,
    args,
  };
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid SemVer version: ${value}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

export function resolveNextVersion(currentVersion, input) {
  const current = parseVersion(currentVersion);

  if (input === "patch") {
    return `${current.major}.${current.minor}.${current.patch + 1}`;
  }
  if (input === "minor") {
    return `${current.major}.${current.minor + 1}.0`;
  }
  if (input === "major") {
    return `${current.major + 1}.0.0`;
  }

  parseVersion(input);
  if (compareVersions(input, currentVersion) <= 0) {
    throw new Error(`Explicit version must be greater than ${currentVersion}`);
  }
  return input;
}

export function ensureVersionConsistency() {
  const pkg = readJson(packageJsonPath);
  const plugin = readJson(pluginManifestPath);
  const lock = readJson(packageLockPath);

  const versions = [
    pkg.version,
    plugin.version,
    lock.version,
    lock.packages?.[""]?.version,
  ];
  const uniqueVersions = [...new Set(versions.filter(Boolean))];

  if (uniqueVersions.length !== 1) {
    throw new Error(
      `Version mismatch detected: package.json=${pkg.version}, openclaw.plugin.json=${plugin.version}, package-lock.json=${lock.version}, package-lock root=${lock.packages?.[""]?.version}`,
    );
  }

  return uniqueVersions[0];
}

export function ensureCleanWorkingTree() {
  const status = run("git", ["status", "--short"], { capture: true });
  if (status) {
    throw new Error("Working tree is not clean. Commit or stash changes before running this release step.");
  }
}

export function ensureReleaseDirectory() {
  fs.mkdirSync(releaseDir, { recursive: true });
}

export function updateVersionFiles(version) {
  const packageJson = readJson(packageJsonPath);
  packageJson.version = version;
  writeJson(packageJsonPath, packageJson);

  const pluginManifest = readJson(pluginManifestPath);
  pluginManifest.version = version;
  writeJson(pluginManifestPath, pluginManifest);

  const packageLock = readJson(packageLockPath);
  packageLock.version = version;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = version;
  }
  writeJson(packageLockPath, packageLock);
}

export function releaseNotesPath(version) {
  return path.join(releaseDir, `release-notes-v${version}.md`);
}

export function buildChangelogSection(version, date, verificationMode = "pending") {
  const verificationLines =
    verificationMode === "passed"
      ? [
          `- \`npm test\` passed on ${date}`,
          `- \`npm run build\` passed on ${date}`,
        ]
      : ["- `npm test` pending", "- `npm run build` pending"];

  return [
    `## ${version} - ${date}`,
    "",
    "Summary:",
    "- TODO: add a one-line release summary.",
    "",
    "New features:",
    "- TODO",
    "",
    "Fixes:",
    "- TODO",
    "",
    "Compatibility:",
    "- No breaking configuration changes.",
    "",
    "Verification:",
    ...verificationLines,
    "",
  ].join("\n");
}

export function changelogHasVersion(version) {
  const changelog = fs.readFileSync(changelogPath, "utf8");
  const headerPattern = new RegExp(`^## ${escapeRegExp(version)}(?: - .+)?$`, "m");
  return headerPattern.test(changelog);
}

export function prependChangelogSection(version, date) {
  const changelog = fs.readFileSync(changelogPath, "utf8");
  if (changelogHasVersion(version)) {
    throw new Error(`CHANGELOG.md already contains version ${version}`);
  }

  const section = buildChangelogSection(version, date, "pending");
  const updated = changelog.replace(/^# Changelog\s*\r?\n\r?\n?/, `# Changelog\n\n${section}`);
  fs.writeFileSync(changelogPath, updated, "utf8");
}

export function extractChangelogSection(version) {
  const changelog = fs.readFileSync(changelogPath, "utf8");
  const match = changelog.match(
    new RegExp(`^## ${escapeRegExp(version)}(?: - .+)?$[\\s\\S]*?(?=^##\\s|\\Z)`, "m"),
  );

  if (!match) {
    throw new Error(`Unable to find CHANGELOG entry for version ${version}`);
  }

  return match[0].trimEnd();
}

export function markVerificationPassed(version, date) {
  const currentSection = extractChangelogSection(version);
  const updatedSection = currentSection
    .replace(/- `npm test` pending/g, `- \`npm test\` passed on ${date}`)
    .replace(/- `npm run build` pending/g, `- \`npm run build\` passed on ${date}`);

  if (currentSection === updatedSection) {
    return false;
  }

  const changelog = fs.readFileSync(changelogPath, "utf8");
  fs.writeFileSync(changelogPath, changelog.replace(currentSection, updatedSection), "utf8");
  return true;
}

export function writeReleaseNotes(version) {
  ensureReleaseDirectory();
  const section = extractChangelogSection(version);
  const body = [`# v${version}`, "", section, ""].join("\n");
  fs.writeFileSync(releaseNotesPath(version), body, "utf8");
}

export function ensureNoTodoInRelease(version) {
  const section = extractChangelogSection(version);
  if (/^\s*-\s*TODO(?:\b|:)/m.test(section)) {
    throw new Error(`CHANGELOG entry for ${version} still contains TODO placeholders`);
  }
}

export function parseRemoteRepo() {
  const remoteUrl = run("git", ["remote", "get-url", "origin"], { capture: true });
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);

  if (!httpsMatch) {
    throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
  }

  return {
    owner: httpsMatch[1],
    repo: httpsMatch[2],
    remoteUrl,
  };
}

export function detectGitHubReleaseMethod() {
  if (commandExists("gh")) {
    return "gh";
  }

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    return null;
  }

  return "api";
}

export async function createGitHubRelease(version, method) {
  const notesFile = releaseNotesPath(version);

  if (method === "gh") {
    run("gh", [
      "release",
      "create",
      `v${version}`,
      "--title",
      `v${version}`,
      "--notes-file",
      notesFile,
    ]);
    return "gh";
  }

  if (method !== "api") {
    return null;
  }

  const { owner, repo } = parseRemoteRepo();
  const body = fs.readFileSync(notesFile, "utf8");
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-memory-domfirst-release-script",
    },
    body: JSON.stringify({
      tag_name: `v${version}`,
      target_commitish: "main",
      name: `v${version}`,
      body,
      draft: false,
      prerelease: false,
      generate_release_notes: false,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub Release API failed (${response.status}): ${errorBody}`);
  }

  return "api";
}

export function ensureTagDoesNotExist(version) {
  const result = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/v${version}`], {
    cwd: repoRoot,
    stdio: "ignore",
    shell: false,
  });

  if (result.status === 0) {
    throw new Error(`Git tag v${version} already exists`);
  }
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
