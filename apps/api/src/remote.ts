import { gitRemotePath } from "@open-relic/contracts";

/**
 * Artifacts hands the remote to the caller rather than having the caller build
 * it, so its host is ours to choose — only the `/git/:namespace/:repo.git` path
 * shape has to match. Deriving the origin from the request means an
 * installation advertises whatever host the client actually reached it on,
 * which is the one host that is certain to work.
 */
export const gitRemoteUrl = (requestUrl: string, namespaceSlug: string, name: string): string =>
  new URL(gitRemotePath(namespaceSlug, name), requestUrl).toString();
