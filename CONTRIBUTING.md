# Contributing to NeedMark

Thank you for helping improve NeedMark. Bug reports and feature requests are welcome in [issues](https://github.com/mssh21/needmark/issues); report security problems as described in [SECURITY.md](SECURITY.md).

## Development

Use the Node.js and pnpm versions in `.mise.toml`, then:

```sh
pnpm install
pnpm build
pnpm demo
```

The project rules for contributors and coding agents are in [AGENTS.md](AGENTS.md). [docs/](docs/README.md) is the reference documentation: update it in the same change as the behavior it describes.

## Pull requests

- Keep each pull request focused on one change.
- Add or update tests as described in [docs/testing.md](docs/testing.md): at the smallest layer that can catch the failure, one behaviour per test, and with a failing test first for bug fixes. Remove tests your change makes redundant.
- Before opening it, make sure `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` pass (CI runs the first three; E2E runs locally). Install the browsers once with `pnpm exec playwright install chromium webkit`. For changes to packaging, the CLI or dependencies, also run `pnpm test:package-managers`.
- Check user-facing changes in the demo.
- Leave `version` in `package.json` unchanged; maintainers bump it when releasing ([docs/releasing.md](docs/releasing.md)).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
