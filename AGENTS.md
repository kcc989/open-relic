# Open Relic — agent guide

An open-source, self-hostable implementation of [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/), built on Cloudflare Durable Objects. See [README.md](./README.md) for the architecture and development commands.

## The compatibility requirement

Open Relic is wire-compatible with Artifacts: a client written against Artifacts must work against an installation with nothing changed but the host. **Read [ADR-0001](./docs/adr/0001-wire-compatible-with-cloudflare-artifacts.md) before designing any endpoint** — it names the surfaces we owe, and the ways the API implemented so far does not yet match. Artifacts' documented behavior wins over this repo's taste.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `kcc989/open-relic`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context — one `CONTEXT.md` and one `docs/adr/` at the repo root. See `docs/agents/domain.md`.
