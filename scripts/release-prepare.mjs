import {
  changelogHasVersion,
  ensureCleanWorkingTree,
  ensureTagDoesNotExist,
  prependChangelogSection,
  readJson,
  resolveNextVersion,
  today,
  updateVersionFiles,
  packageJsonPath,
  writeReleaseNotes,
} from "./release-lib.mjs";

const input = process.argv[2];

if (!input) {
  console.error("Usage: npm run release:prepare -- <patch|minor|major|x.y.z>");
  process.exit(1);
}

const packageJson = readJson(packageJsonPath);
const currentVersion = packageJson.version;
const nextVersion = resolveNextVersion(currentVersion, input);
const releaseDate = today();

ensureCleanWorkingTree();

if (changelogHasVersion(nextVersion)) {
  console.error(`CHANGELOG.md already contains version ${nextVersion}`);
  process.exit(1);
}

ensureTagDoesNotExist(nextVersion);

updateVersionFiles(nextVersion);

prependChangelogSection(nextVersion, releaseDate);
writeReleaseNotes(nextVersion);

console.log(`Prepared release ${nextVersion}.`);
console.log("Updated files:");
console.log("- package.json");
console.log("- package-lock.json");
console.log("- openclaw.plugin.json");
console.log("- CHANGELOG.md");
console.log(`- release/release-notes-v${nextVersion}.md`);
console.log("");
console.log("Next steps:");
console.log("1. Replace TODO placeholders in CHANGELOG.md.");
console.log("2. Run: npm run release:publish");
