# `@openrelic/alchemy`

Deploy [Open Relic](https://github.com/kcc989/open-relic) into your Cloudflare
account with Alchemy, then bind an Artifacts-compatible namespace into another
Worker.

## Install

```sh
npm install @openrelic/alchemy alchemy effect
# or: bun add @openrelic/alchemy alchemy effect
# or: pnpm add @openrelic/alchemy alchemy effect
# or: yarn add @openrelic/alchemy alchemy effect
```

The package runs deployment code under Node.js or Bun. The Worker entrypoints
and runtime client it ships are Cloudflare Worker-compatible and are bundled
into the deployed Workers; installing it does not start a Node server or connect
to a shared Open Relic service.

## Deploy and bind a namespace

Set an installation-wide REST API token of at least 32 bytes in the deploy
environment:

```sh
export OPEN_RELIC_API_TOKEN="$(openssl rand -hex 32)"
```

Then use the package from `alchemy.run.ts`:

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as OpenRelic from "@openrelic/alchemy";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const relic = yield* OpenRelic.Installation("Relic");
    const repos = yield* OpenRelic.Namespace(relic, {
      namespace: "default",
    });

    const app = yield* Cloudflare.Worker("App", {
      main: "./src/index.ts",
      env: { ARTIFACTS: repos },
    });

    return { appUrl: app.url, relicUrl: relic.publicUrl };
  }),
);
```

Alchemy's inferred application environment exposes the same namespace API as
the pinned Cloudflare Artifacts binding:

```ts
import * as OpenRelic from "@openrelic/alchemy/worker";

interface Env {
  ARTIFACTS: OpenRelic.Artifacts;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const artifacts = OpenRelic.client(env.ARTIFACTS);
    const created = await artifacts.create("agent-workspace");
    const repository = await artifacts.get(created.name);
    const readToken = await repository.createToken("read", 3600);

    return Response.json({ remote: created.remote, token: readToken.plaintext });
  },
} satisfies ExportedHandler<Env>;
```

`OpenRelic.client()` is recommended because Workers RPC does not propagate
custom error properties. It preserves `ArtifactsError.code` and
`ArtifactsError.numericCode` through a tagged transport. Successful calls may
also be made directly on `env.ARTIFACTS`.

`Installation` owns only deployed service infrastructure. `Namespace` is the
runtime capability; repositories and Git tokens are created dynamically by
deployed application code and are not Alchemy resources.

## Bind without Alchemy

The installation Worker also exports `OpenRelicArtifacts` as a named entrypoint,
so a Worker deployed by Wrangler can use the same client through a same-account
service binding:

```toml
[[services]]
binding = "OPEN_RELIC"
service = "open-relic-api"
entrypoint = "OpenRelicArtifacts"

[services.props]
namespace = "default"
publicUrl = "https://open-relic.example.com"
```

Type the binding and restore full error details with the runtime-only subpath:

```ts
import * as OpenRelic from "@openrelic/alchemy/worker";

interface Env {
  OPEN_RELIC: OpenRelic.Artifacts & OpenRelic.ArtifactsBindingTransport;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const artifacts = OpenRelic.createOpenRelicArtifacts(env.OPEN_RELIC);
    return Response.json(await artifacts.list());
  },
} satisfies ExportedHandler<Env>;
```
