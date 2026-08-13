import {
  ARTIFACT_TOKEN_SECRET_LENGTH,
  TOKEN_TTL_DEFAULT_SECONDS,
  formatArtifactToken,
  gitRemotePath,
} from "@open-relic/contracts";

/**
 * Artifacts hands the remote to the caller rather than having the caller build
 * it, so its host is ours to choose — only the `/git/:namespace/:repo.git` path
 * shape has to match. Deriving the origin from the request means an
 * installation advertises whatever host the client actually reached it on,
 * which is the one host that is certain to work.
 */
export const gitRemoteUrl = (
  requestUrl: string,
  namespaceSlug: string,
  name: string,
): string => new URL(gitRemotePath(namespaceSlug, name), requestUrl).toString();

/**
 * The one token a repository create hands back.
 *
 * Nothing stores or verifies it yet: the token API is still a stub and the Git
 * surface answers `501`, so this mints a correctly shaped secret and no more.
 * Persisting it belongs with the work that makes tokens checkable, and issuing
 * a token the Git side would have to honor before that side exists would be the
 * wrong half to build first.
 */
export const mintArtifactToken = (
  ttlSeconds: number = TOKEN_TTL_DEFAULT_SECONDS,
): string => {
  const bytes = crypto.getRandomValues(
    new Uint8Array(ARTIFACT_TOKEN_SECRET_LENGTH / 2),
  );
  const secret = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return formatArtifactToken(secret, new Date(Date.now() + ttlSeconds * 1000));
};
