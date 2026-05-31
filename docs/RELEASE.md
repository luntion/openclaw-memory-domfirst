# Release Guide

This repository now uses a standardized GitHub release workflow instead of treating the remote branch as a disposable mirror.

## Repository Roles

- official GitHub repository: `luntion/openclaw-memory-domfirst`
- only publish source: `D:\AI-workspace\openclaw-memory-domfirst-publish`
- `D:\AI-workspace\openclaw-memory-hybrid` remains a local development or staging source and should not push directly to `main`

## Versioning Rules

This repository follows `SemVer`.

- `patch`
  documentation fixes, small fixes, and no interface changes
- `minor`
  new features, new endpoints, new tools, or new plugin capabilities
- `major`
  breaking changes, incompatible config changes, or removed/renamed interfaces

Every release must update all of the following in sync:

- `package.json`
- `package-lock.json`
- `openclaw.plugin.json`
- `CHANGELOG.md`
- Git tag such as `v0.4.1`

## Standard Release Flow

### 1. Sync release changes into the publish repository

Bring the code you want to ship into:

```text
D:\AI-workspace\openclaw-memory-domfirst-publish
```

### 2. Prepare the release version

Choose either a SemVer bump type or an explicit target version.

Examples:

```bash
npm run release:prepare -- patch
npm run release:prepare -- minor
npm run release:prepare -- major
npm run release:prepare -- 0.4.1
```

This updates:

- `package.json`
- `package-lock.json`
- `openclaw.plugin.json`
- `CHANGELOG.md`
- `release/release-notes-vX.Y.Z.md`

`CHANGELOG.md` is seeded with the required structure:

- version number
- release date
- summary
- new features
- fixes
- compatibility
- verification

Before publishing, replace all `TODO` placeholders in the new changelog entry.

### 3. Publish the release

Run:

```bash
npm run release:publish
```

This does the following:

1. runs `npm test`
2. runs `npm run build`
3. marks verification results in `CHANGELOG.md`
4. regenerates the release notes file
5. commits the release with `Release X.Y.Z`
6. pushes `main`
7. creates Git tag `vX.Y.Z`
8. pushes the tag
9. creates the GitHub Release when automation is configured

## GitHub Release Automation

`release:publish` supports two automation paths:

- GitHub CLI via `gh auth login`
- GitHub API via `GH_TOKEN` or `GITHUB_TOKEN`

If neither is configured, the script stops before pushing by default.

If you intentionally want to push commit and tag first, then create the GitHub Release manually, use:

```bash
npm run release:publish -- --allow-manual-release
```

The script will print:

- the release tag
- the release title
- the generated notes file path
- the GitHub release creation URL

## Packaging Artifacts

If you also want a local distributable package after the release is prepared, use:

### Windows

```powershell
npm run package:ps
```

### macOS / Linux

```bash
npm run package:sh
```

Artifacts are written to:

```text
release/
```

## Release Checklist

1. confirm the code in `openclaw-memory-domfirst-publish` is the exact code to ship
2. run `npm run release:prepare -- <patch|minor|major|x.y.z>`
3. replace `TODO` items in `CHANGELOG.md`
4. run `npm run release:publish`
5. if needed, run `npm run package:ps` or `npm run package:sh`
6. verify the GitHub Release page matches the changelog summary
