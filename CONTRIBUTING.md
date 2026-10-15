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
- Add or update tests as described in [docs/testing.md](docs/testing.md).
- Before opening it, make sure `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` pass. For changes to packaging, the CLI or dependencies, also run `pnpm test:package-managers`.
- Check user-facing changes in the demo.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
