import {
  createGitHubRelease,
  detectGitHubReleaseMethod,
  ensureNoTodoInRelease,
  ensureTagDoesNotExist,
  ensureVersionConsistency,
  markVerificationPassed,
  parseRemoteRepo,
  releaseNotesPath,
  run,
  today,
  writeReleaseNotes,
} from "./release-lib.mjs";

const args = new Set(process.argv.slice(2));
const allowManualRelease = args.has("--allow-manual-release");

const version = ensureVersionConsistency();
const releaseDate = today();
const { owner, repo } = parseRemoteRepo();
const releaseMethod = detectGitHubReleaseMethod();

ensureNoTodoInRelease(version);
ensureTagDoesNotExist(version);

run("npm", ["run", "verify:release"]);
markVerificationPassed(version, releaseDate);
writeReleaseNotes(version);

if (!releaseMethod && !allowManualRelease) {
  console.error("GitHub Release automation is not configured.");
  console.error("Install GitHub CLI with `gh auth login`, or set `GH_TOKEN` / `GITHUB_TOKEN`.");
  console.error("If you want to push commit and tag first, rerun with `npm run release:publish -- --allow-manual-release`.");
  process.exit(1);
}

run("git", ["add", "-A"]);

const status = run("git", ["status", "--short"], { capture: true });
if (status) {
  run("git", ["commit", "-m", `Release ${version}`]);
}

run("git", ["push", "origin", "main"]);
run("git", ["tag", "-a", `v${version}`, "-m", `Release v${version}`]);
run("git", ["push", "origin", `v${version}`]);

if (releaseMethod) {
  try {
    await createGitHubRelease(version, releaseMethod);
  } catch (error) {
    console.error(String(error));
    console.error(`Commit and tag for v${version} were already pushed. Create the release manually if needed.`);
    process.exit(1);
  }
}

if (!releaseMethod) {
  const notesFile = releaseNotesPath(version);
  console.log(`Release commit and tag for v${version} have been pushed.`);
  console.log(`Create the GitHub Release manually for ${owner}/${repo}:`);
  console.log(`- tag: v${version}`);
  console.log(`- title: v${version}`);
  console.log(`- notes file: ${notesFile}`);
  console.log(`- release page: https://github.com/${owner}/${repo}/releases/new?tag=v${version}`);
  process.exit(0);
}

console.log(`Published v${version} to ${owner}/${repo} using ${releaseMethod}.`);
