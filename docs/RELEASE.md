# Release Guide

This repository now supports a minimal release workflow for local packaging.

## Current Release Target

- version: `0.2.0`
- package name: `openclaw-memory-hybrid`

## Before Packaging

Run:

```bash
npm run verify:release
```

This checks:

- tests
- TypeScript build

## Package Commands

### Windows

```powershell
npm run package:ps
```

### macOS / Linux

```bash
npm run package:sh
```

## Output

Artifacts are written to:

```text
release/
```

Expected contents:

- source snapshot zip or tar.gz
- release manifest

## Included Files

The release package includes:

- plugin entry
- local memory service
- source code
- docs
- scripts
- manifest and package metadata

It does not include:

- `.git`
- `node_modules`
- local database files
- release directory contents from previous runs

## Suggested Release Checklist

1. Confirm version in `package.json` and `openclaw.plugin.json`
2. Run `npm run verify:release`
3. Run the packaging script
4. Review `CHANGELOG.md`
5. Review `docs/PRODUCT_CN.md` or `docs/PRODUCT.md`
6. Publish or archive the generated artifact
