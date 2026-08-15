import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  Artifacts,
  ArtifactsBindingProps,
  ArtifactsBindingRequest,
  ArtifactsBindingResult,
  ArtifactsCreateRepoResult,
  ArtifactsRepo,
  ArtifactsRepoListResult,
} from "@openrelic/alchemy/worker";

import type { ApiEnv } from "../../../alchemy.run.ts";
import {
  namespaceRegistryFromEnv,
  repositoryIndexFromEnv,
  repositoryObjectsFromEnv,
  tokenRegistryFromEnv,
} from "./bindings.ts";
import { ArtifactsBindingService, invokeArtifactsBinding } from "./artifacts-binding-service.ts";

/**
 * A same-account custom binding for one Open Relic namespace. Cloudflare
 * authenticates `ctx.props` as deployment configuration, so deployed code can
 * call this entrypoint without carrying the installation-wide REST API token.
 */
export class OpenRelicArtifacts
  extends WorkerEntrypoint<ApiEnv, ArtifactsBindingProps>
  implements Artifacts
{
  create(
    name: string,
    opts?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactsCreateRepoResult> {
    return this.#service().create(name, opts);
  }

  get(name: string): Promise<ArtifactsRepo> {
    return this.#service().get(name);
  }

  import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: {
      name: string;
      opts?: { description?: string; readOnly?: boolean };
    };
  }): Promise<ArtifactsCreateRepoResult> {
    return this.#service().import(params);
  }

  list(opts?: { limit?: number; cursor?: string }): Promise<ArtifactsRepoListResult> {
    return this.#service().list(opts);
  }

  delete(name: string): Promise<boolean> {
    return this.#service().delete(name);
  }

  /** Error-preserving transport for `createOpenRelicArtifacts()`. */
  invoke(request: ArtifactsBindingRequest): Promise<ArtifactsBindingResult> {
    return invokeArtifactsBinding(this.#service(), request);
  }

  #service(): ArtifactsBindingService {
    return new ArtifactsBindingService(this.ctx.props, {
      namespaces: namespaceRegistryFromEnv(this.env),
      repositories: repositoryIndexFromEnv(this.env),
      objects: repositoryObjectsFromEnv(this.env),
      tokens: tokenRegistryFromEnv(this.env),
    });
  }
}

/**
 * Unscoped transport used by the Alchemy adapter Worker. Configuration is an
 * explicit structured-clone value because Alchemy beta.72 cannot upload
 * service-binding props yet; only same-account service bindings can reach it.
 */
export class OpenRelicArtifactsTransport extends WorkerEntrypoint<ApiEnv> {
  invoke(input: {
    readonly props: ArtifactsBindingProps;
    readonly request: ArtifactsBindingRequest;
  }): Promise<ArtifactsBindingResult> {
    const service = new ArtifactsBindingService(input.props, {
      namespaces: namespaceRegistryFromEnv(this.env),
      repositories: repositoryIndexFromEnv(this.env),
      objects: repositoryObjectsFromEnv(this.env),
      tokens: tokenRegistryFromEnv(this.env),
    });
    return invokeArtifactsBinding(service, input.request);
  }
}
