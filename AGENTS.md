# Formatting — read before touching any JS/TS file

This project is formatted by **`@artemiy/oxfmt-allman`**, a fork of [oxfmt](https://oxc.rs/docs/guide/usage/formatter)
that adds Allman brace style. It is **not** on the public npm registry — it lives in a private
GitLab package registry.

## Hard rules

- **Do not** install or run `prettier`, `biome`, `dprint`, or upstream `oxfmt`. They will move every
  opening brace back and produce a diff touching the whole file.
- **Do not** edit or delete `braceStyle` in `.oxfmtrc.json`.
- **Do not** hand-align braces. Edit the code, then run the formatter and let it place them.
- The installed binary is called **`oxfmt`**, not `oxfmt-allman`.
- ⚠️ **Do not run `npx oxfmt`.** It resolved to **upstream `oxfmt@0.62.0` from the public npm
  registry** (`npm warn exec The following package was not found and will be installed`) even
  with `@artemiy/oxfmt-allman` present in `node_modules`. Upstream is the Node/NAPI hybrid that
  delegates to Prettier, so it does not silently skip `.html` — it reformatted the
  `__fixtures__/*.html` snapshots and **16 tests went red**, because the parser binds bets to
  the nearest `.koef` by distance in text. Use `bun run format` (or
  `./node_modules/.bin/oxfmt <paths>`) — those resolve the local fork.
- Config must be **`.oxfmtrc.json`** or `.oxfmtrc.jsonc`. `oxfmt.config.ts` is rejected by this
  build with `JS/TS config file is not supported in pure Rust CLI`.

## After editing code

Run the formatter on what you changed, then verify:

```sh
./node_modules/.bin/oxfmt extension/src   # formats in place (default, no --write needed)
bun run format:check                      # exits non-zero if anything is unformatted
```

`--check` exits `1` when something is unformatted and `0` when everything is clean, so it works as
a CI gate. `--list-different` prints just the paths that would change, which is cheaper to read
than a diff.

`npx oxfmt` on a file type it does not support is **not** an error: it exits `0` and reports
`Finished ... on 0 files`. Check the file count, not just the exit code, if you need proof that
something was actually formatted.

## Project setup (only if `npx oxfmt` is missing)

The package is private, so a plain `npm i @artemiy/oxfmt-allman` fails with `404 Not Found`. Point
the scope at the GitLab registry first.

Create `.npmrc` in the project root — **with the `${NPM_TOKEN}` placeholder, never a literal token**:

```
@artemiy:registry=https://gitlab.kiviuly.ru/api/v4/projects/40/packages/npm/
//gitlab.kiviuly.ru/api/v4/projects/40/packages/npm/:_authToken=${NPM_TOKEN}
```

Then install, with the token supplied from the environment:

```sh
NPM_TOKEN=<token> npm i -D @artemiy/oxfmt-allman@0.62.0
```

The token needs the `api` scope (a GitLab deploy token with `read_package_registry` also works for
installing). In CI use `NPM_TOKEN=${CI_JOB_TOKEN}`.

## Config

`.oxfmtrc.json`:

```json
{
  "braceStyle": "allman"
}
```

Accepted values:

| Value | Effect |
| --- | --- |
| `"1tbs"` | Upstream/Prettier behaviour. This is the default — omitting `braceStyle` disables the fork's whole point. |
| `"stroustrup"` | Brace stays on the line, but `else` / `catch` / `finally` / `while` start a new one. |
| `"allman"` | Every opening brace on its own line. **This is what this project uses.** |

Every other option (`printWidth`, `semi`, `singleQuote`, `sortImports`, …) behaves exactly like
upstream oxfmt 0.60.0.

## What the output looks like

```ts
export function demo(x: number)
{
  if (x > 0)
  {
    return { a: 1, b: 2 };
  }
  else
  {
    throw new Error("nope");
  }
}
```

Two cases where the brace **correctly stays** on the previous line — do not "fix" them:

1. **Short object and type literals.** They only move the brace once they break. `const a = { x: 1 };`
   staying on one line is intended, not a missed case.
2. **After `return`, `throw` and `yield`.** A line break there would be swallowed by automatic
   semicolon insertion and silently change behaviour, so the formatter keeps the brace attached:

   ```js
   return { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5, zeta: 6, eta: 777 };
   ```

   This also applies when the literal only starts the expression, as in `return { ...a }.value`.

## Limitations — do not file these as bugs

This build is the pure-Rust CLI, not the Node/NAPI hybrid upstream ships.

- **Handles** (verified by running it): `.js` `.jsx` `.ts` `.tsx` `.json` `.jsonc` `.css` `.scss`
  `.less` `.graphql` `.toml`.
- **Silently skips** (no error, file left byte-for-byte alone): `.vue`, `.svelte`, `.md`, `.html`,
  `.yaml` / `.yml`, and anything else. Those need upstream's Node build, which delegates to
  Prettier. Do not try to make them work here — leave those files unformatted.
- **No embedded-language formatting.** CSS or GraphQL inside a template literal (css-in-js,
  gql-in-js) is left as written, even though standalone `.css` / `.graphql` files are formatted.
- `braceStyle` only affects JS/TS/JSX/TSX. It has no effect on CSS, JSON, GraphQL or TOML.
- **No stdin, no LSP, no Node API.** Editor "format on save" via an oxfmt LSP plugin will not work;
  run the CLI instead.

## Platforms

One package bundles every binary and selects the right one at runtime. Supported: Linux x64 and
arm64 (both glibc and musl), macOS x64 and arm64, Windows x64 and arm64.

This works in Docker on Ubuntu/Debian (glibc) and Alpine (musl) with no extra setup — install it
like any other dev dependency; do **not** download a binary manually. The package is around 20 MB
compressed because it carries all eight binaries.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `404 Not Found - @artemiy/oxfmt-allman` | Scope not mapped to the GitLab registry | Add the `.npmrc` above |
| `401 Unauthorized` | `NPM_TOKEN` unset, expired, or lacks `api` scope | Export a valid token |
| `no bundled binary for <platform>` | Not Linux/macOS/Windows on x64/arm64 | Build from source: `cargo build -p oxfmt --release --no-default-features` |
| `JS/TS config file … is not supported` | An `oxfmt.config.ts` exists | Convert it to `.oxfmtrc.json` |
| Braces reverted across many files | Prettier/Biome ran | Revert, remove that formatter from scripts and hooks, re-run `npx oxfmt` |
| `oxfmt: command not found` | Looked for `oxfmt-allman` | The binary is `oxfmt` |
