import { WorkerEntrypoint } from "cloudflare:workers";

import {
  createOpenRelicArtifacts,
  type Artifacts,
  type ArtifactsBindingRequest,
  type ArtifactsBindingResult,
  type ArtifactsCreateRepoResult,
  type ArtifactsRepo,
  type ArtifactsRepoListResult,
  type InstallationBindingTransport,
} from "./worker.js";

interface NamespaceWorkerEnv {
  readonly OPEN_RELIC: InstallationBindingTransport;
  readonly OPEN_RELIC_NAMESPACE: string;
  readonly OPEN_RELIC_PUBLIC_URL: string;
}

/**
 * Namespace-scoped adapter deployed by `Namespace()`. It makes the current
 * Alchemy release's props limitation invisible to application Workers.
 */
export class OpenRelicNamespace extends WorkerEntrypoint<NamespaceWorkerEnv> implements Artifacts {
  create(
    name: string,
    opts?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactsCreateRepoResult> {
    return this.#client().create(name, opts);
  }

  get(name: string): Promise<ArtifactsRepo> {
    return this.#client().get(name);
  }

  import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: {
      name: string;
      opts?: { description?: string; readOnly?: boolean };
    };
  }): Promise<ArtifactsCreateRepoResult> {
    return this.#client().import(params);
  }

  list(opts?: { limit?: number; cursor?: string }): Promise<ArtifactsRepoListResult> {
    return this.#client().list(opts);
  }

  delete(name: string): Promise<boolean> {
    return this.#client().delete(name);
  }

  invoke(request: ArtifactsBindingRequest): Promise<ArtifactsBindingResult> {
    return this.env.OPEN_RELIC.invoke({
      props: {
        namespace: this.env.OPEN_RELIC_NAMESPACE,
        publicUrl: this.env.OPEN_RELIC_PUBLIC_URL,
      },
      request,
    });
  }

  #client(): Artifacts {
    return createOpenRelicArtifacts({ invoke: (request) => this.invoke(request) });
  }
}
