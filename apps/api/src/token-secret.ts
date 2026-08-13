import {
  ARTIFACT_TOKEN_ID_LENGTH,
  ARTIFACT_TOKEN_PATTERN,
  ARTIFACT_TOKEN_PREFIX,
  ARTIFACT_TOKEN_SECRET_LENGTH,
  formatArtifactToken,
} from "@open-relic/contracts";

const randomHex = (length: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length / 2));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export interface MintedToken {
  readonly id: string;
  readonly plaintext: string;
  readonly secret: string;
  readonly expiresAt: Date;
  readonly expiresAtUnix: number;
}

export const mintToken = (now: Date, ttlSeconds: number): MintedToken => {
  const secret = randomHex(ARTIFACT_TOKEN_SECRET_LENGTH);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  return {
    id: randomHex(ARTIFACT_TOKEN_ID_LENGTH),
    plaintext: formatArtifactToken(secret, expiresAt),
    secret,
    expiresAt,
    expiresAtUnix: Math.floor(expiresAt.getTime() / 1000),
  };
};

export interface ParsedToken {
  readonly secret: string;
  /** Present on the Bearer spelling; Basic carries only the secret half. */
  readonly expiresAtUnix: number | null;
}

export const parseToken = (plaintext: string): ParsedToken | null => {
  if (ARTIFACT_TOKEN_PATTERN.test(plaintext)) {
    const separator = plaintext.indexOf("?expires=");
    const expiresAtUnix = Number(plaintext.slice(separator + "?expires=".length));
    if (!Number.isSafeInteger(expiresAtUnix)) {
      return null;
    }

    return {
      secret: plaintext.slice(ARTIFACT_TOKEN_PREFIX.length, separator),
      expiresAtUnix,
    };
  }

  const bareSecret = new RegExp(
    `^${ARTIFACT_TOKEN_PREFIX}[0-9a-f]{${ARTIFACT_TOKEN_SECRET_LENGTH}}$`,
  );
  return bareSecret.test(plaintext)
    ? { secret: plaintext.slice(ARTIFACT_TOKEN_PREFIX.length), expiresAtUnix: null }
    : null;
};

export const hashTokenSecret = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
