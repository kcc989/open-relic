import type { Output } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import {
  createOpenRelicArtifacts,
  type Artifacts,
  type ArtifactsBindingTransport,
} from "./worker.js";

export * from "./worker.js";

const TRANSPORT_ENTRYPOINT = "OpenRelicArtifactsTransport";
const NAMESPACE_ENTRYPOINT = "OpenRelicNamespace";
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const NAMESPACE_MAX_LENGTH = 39;
const RESERVED_NAMESPACES = new Set(["api", "git", "healthz", "static", "well-known"]);
const API_TOKEN_MIN_BYTES = 32;
const API_TOKEN_VARIABLE = "OPEN_RELIC_API_TOKEN";

/** Bundled Worker entry modules shipped in this package's dist directory. */
const workerEntrypoint = new URL("../dist/open-relic-worker.js", import.meta.url).pathname;
const namespaceWorkerEntrypoint = new URL("../dist/namespace-worker.js", import.meta.url).pathname;

export interface Installation {
  /** The deployed Open Relic API Worker. */
  readonly worker: Cloudflare.Worker;
  /** Canonical public URL used in Git remotes returned by the binding. */
  readonly publicUrl: Output<string>;
}

export interface InstallationProps {
  /**
   * Installation-wide REST API token. When omitted, Installation reads
   * `OPEN_RELIC_API_TOKEN` from the deploy process and fails closed if absent.
   */
  readonly apiToken?: Redacted.Redacted<string>;
  readonly compatibility?: {
    readonly date?: string;
    readonly flags?: readonly string[];
  };
  readonly observability?: Cloudflare.WorkerObservability;
}

const apiTokenForDeployment = (token: string | undefined): string => {
  if (
    token !== undefined &&
    token.length > 0 &&
    new TextEncoder().encode(token).byteLength < API_TOKEN_MIN_BYTES
  ) {
    throw new Error(`${API_TOKEN_VARIABLE} must be at least ${API_TOKEN_MIN_BYTES} bytes.`);
  }
  return token ?? "";
};

/**
 * Deploy a complete Open Relic installation into the active Alchemy
 * Cloudflare stack: API Worker, registry Durable Object, and repository
 * Durable Objects.
 */
export const Installation = Effect.fn(function* (name: string, props: InstallationProps = {}) {
  const worker = yield* Cloudflare.Worker(name, {
    main: workerEntrypoint,
    compatibility: {
      date: props.compatibility?.date ?? "2026-07-11",
      flags: [...(props.compatibility?.flags ?? ["nodejs_compat"])],
    },
    limits: { cpuMs: 300_000 },
    env: {
      NAMESPACES: Cloudflare.DurableObject(`${name}Namespaces`, {
        className: "NamespaceRegistryObject",
      }),
      REPOSITORIES: Cloudflare.DurableObject(`${name}Repositories`, {
        className: "RepositoryObject",
      }),
      OPEN_RELIC_API_TOKEN:
        props.apiToken ?? Redacted.make(apiTokenForDeployment(process.env[API_TOKEN_VARIABLE])),
    },
    observability: props.observability ?? { enabled: true },
  });

  // Installation leaves workers.dev enabled, so the deployed Worker always
  // has a URL even though Alchemy's general Worker output also models private
  // Workers that do not.
  return { worker, publicUrl: worker.url.as<string>() } satisfies Installation;
});

export interface NamespaceProps {
  /** Open Relic namespace slug scoped into the runtime binding. */
  readonly namespace: string;
  /** Descriptive marker name retained for plans and inspection. */
  readonly name?: string;
}

export class InvalidNamespaceError extends Error {
  constructor(readonly namespace: string) {
    super(
      `Invalid Open Relic namespace '${namespace}'. Use at most ${NAMESPACE_MAX_LENGTH} lowercase letters, digits, and interior hyphens, and avoid reserved API paths.`,
    );
  }
}

const namespaceBinding = (
  worker: Cloudflare.Worker,
  name: string,
  namespace: string,
): Cloudflare.Artifacts.Namespace => {
  const binding = Cloudflare.WorkerEntrypoint(worker, NAMESPACE_ENTRYPOINT);
  const configured = Object.assign(binding, { name, namespace });
  return markArtifactsNamespace(configured);
};

type NamespaceEntrypointMarker = Cloudflare.WorkerEntrypointBinding & {
  readonly name: string;
  readonly namespace: string;
};

const markArtifactsNamespace = (
  binding: NamespaceEntrypointMarker,
): Cloudflare.Artifacts.Namespace => {
  // SAFETY: OpenRelicNamespace implements the pinned Artifacts API. The
  // static marker teaches InferEnv that API, while Alchemy classifies the
  // actual WorkerEntrypoint `kind` during deployment.
  return binding as NamespaceEntrypointMarker & Cloudflare.Artifacts.Namespace;
};

/**
 * Bind one namespace from an {@link Installation} into a consumer Worker.
 * Repositories and Git tokens remain runtime results of this capability.
 */
export const Namespace = Effect.fn(function* (installation: Installation, props: NamespaceProps) {
  if (
    props.namespace.length === 0 ||
    props.namespace.length > NAMESPACE_MAX_LENGTH ||
    !NAMESPACE_PATTERN.test(props.namespace) ||
    RESERVED_NAMESPACES.has(props.namespace)
  ) {
    return yield* Effect.die(new InvalidNamespaceError(props.namespace));
  }

  const name = props.name ?? `${props.namespace}Artifacts`;
  const adapter = yield* Cloudflare.Worker(name, {
    main: namespaceWorkerEntrypoint,
    compatibility: { date: "2026-07-11" },
    workersDev: false,
    env: {
      OPEN_RELIC: Cloudflare.WorkerEntrypoint(installation.worker, TRANSPORT_ENTRYPOINT),
      OPEN_RELIC_NAMESPACE: props.namespace,
      OPEN_RELIC_PUBLIC_URL: installation.publicUrl,
    },
  });
  return namespaceBinding(adapter, name, props.namespace);
});

type ArtifactsClientBinding = Artifacts & {
  readonly invoke?: ArtifactsBindingTransport["invoke"];
};

/** Restore full `ArtifactsError` fields around an Alchemy namespace binding. */
export const client = (binding: ArtifactsClientBinding): Artifacts => {
  if (binding.invoke === undefined) {
    throw new TypeError("OpenRelic.client() requires a binding returned by OpenRelic.Namespace().");
  }
  const invoke = binding.invoke;
  return createOpenRelicArtifacts({ invoke: (request) => invoke(request) });
};
