/** Local workerd benchmark only. The runner binds this service to loopback. */
import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";

import migrations from "../../apps/api/drizzle/repository/migrations.js";
import { ObjectStore } from "../../apps/api/src/object-store.ts";
import { readPack } from "../../apps/api/src/pack.ts";
import { findMissingObject } from "../../apps/api/src/connectivity.ts";
import { uploadPackResultStream } from "../../apps/api/src/git/upload-pack.ts";

export class BenchmarkRepository extends DurableObject {
  readonly #objects: ObjectStore;
  constructor(ctx: DurableObjectState, env: BenchmarkEnv) {
    super(ctx, env);
    const db = drizzle(ctx.storage);
    const kv = ctx.storage.kv;
    this.#objects = new ObjectStore(db, {
      get: <T>(key: string) => kv.get<T>(key),
      put: <T>(key: string, value: T) => kv.put(key, value),
      delete: (key: string) => {
        kv.delete(key);
      },
    });
    ctx.blockConcurrencyWhile(async () => {
      migrate(db, migrations);
    });
  }
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const tip = url.searchParams.get("tip") ?? "";
    if (url.pathname === "/ingest") {
      return Response.json(await readPack(request.body!, this.#objects));
    }
    if (url.pathname === "/parse") {
      return Response.json(
        await readPack(request.body!, { read: async () => null, write: async () => {} }),
      );
    }
    if (url.pathname === "/fetch") {
      return new Response(uploadPackResultStream(request.body!, this.#objects, new Set([tip])));
    }
    if (url.pathname === "/check") {
      return Response.json({
        missing: await findMissingObject(tip, this.#objects, {
          verified: new Set(),
          visited: new Set(),
        }),
      });
    }
    return new Response("Unknown benchmark operation", { status: 404 });
  }
}

interface BenchmarkEnv {
  readonly REPOSITORIES: DurableObjectNamespace<BenchmarkRepository>;
}
export default {
  fetch(request: Request, env: BenchmarkEnv): Promise<Response> {
    const id = env.REPOSITORIES.idFromName(request.headers.get("x-repository") ?? "default");
    return env.REPOSITORIES.get(id).fetch(request);
  },
};
