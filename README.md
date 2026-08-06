# @texoport

This is my pnpm monorepo for independently published packages, mostly related to Effect. It currently contains:

- `@texoport/effect-ai-claude`, an Effect `LanguageModel` provider that calls the signed-in `claude` CLI.
- `@texoport/effect-ai-codex`, an Effect `LanguageModel` provider that calls the signed-in `codex` CLI.

## Daily work

Run `pnpm check` before opening a PR. When a change should ship, run `pnpm changeset`, select the affected package and bump type, and commit the generated markdown file with the code. Changesets keeps the two package versions independent.

## Releases

Merging a changeset to `main` creates or updates a **Version Packages** pull request. Merging that PR publishes the versioned packages, creates GitHub releases, and generates changelogs. The release workflow uses npm trusted publishing, so it has no reusable npm publish token.

Before the first release, configure a trusted publisher for each package on npm with repository `saiashirwad/texoport` and workflow `.github/workflows/release.yml`; allow `npm publish`. The workflow file and the `id-token: write` permission must match that configuration exactly. See npm's [trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).

For a local one-off publish, log in with `npm login`, run `pnpm version-packages`, inspect the result, then run `pnpm release`.
