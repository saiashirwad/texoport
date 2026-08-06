# @texoport

My pnpm monorepo. Most of what's here will be Effect-related, but I'm leaving room for the odd package that isn't.

- `@texoport/effect-ai-claude`, an Effect `LanguageModel` provider that calls the signed-in `claude` CLI.
- `@texoport/effect-ai-codex`, an Effect `LanguageModel` provider that calls the signed-in `codex` CLI.

## Working here

Run `pnpm check` before opening a PR. If the change needs a release, run `pnpm changeset`, pick the package and version bump, then commit the markdown file it writes. The Claude and Codex packages get their own versions.

The root package is private and holds the maintenance commands. Run `pnpm command --help` to see them.

## Releases

When a changeset reaches `main`, the release workflow opens or updates a Version Packages PR. Merge that PR and it publishes the packages, creates GitHub releases, and writes the changelogs. It uses npm trusted publishing, so there is no publish token sitting in GitHub secrets.

The first publish of a package needs a normal `npm login`, because npm only lets you add a trusted publisher after the package exists. Once it is published, run `pnpm setup:npm-publishers`. It registers every public workspace package to trust `saiashirwad/texoport` and `release.yml` for `npm publish`. Run it again after adding a new package. The workflow name and `id-token: write` permission have to match npm's configuration exactly. npm's [trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) has the setup screens.

For a local release, run `npm login`, `pnpm version-packages`, inspect the version changes, then run `pnpm release`.
