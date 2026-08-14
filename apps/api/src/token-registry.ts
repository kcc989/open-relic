import {
  type CreateTokenResult,
  type TokenInfo,
  type TokenListState,
  type TokenScope,
} from "@open-relic/contracts";
import { and, count, desc, eq, gt, isNotNull, isNull, lte, type SQL } from "drizzle-orm";

import type { SyncSqliteDatabase } from "./db/database.ts";
import { repositories, tokens, type TokenRow } from "./db/registry-schema.ts";
import { hashTokenSecret, mintToken, parseToken } from "./token-secret.ts";
import {
  LocalRegistryStorage,
  REGISTRY_DATABASE,
  REGISTRY_NOW,
  type RegistryStorageConstructor,
} from "./registry-storage.ts";

export interface CreateTokenCommand {
  readonly namespaceSlug: string;
  readonly repositoryName: string;
  readonly scope: TokenScope;
  readonly ttlSeconds: number;
}

export type CreateTokenOutcome =
  | { readonly created: true; readonly token: CreateTokenResult }
  | { readonly created: false; readonly reason: "repository-missing" };

export interface ListTokensQuery {
  readonly state: TokenListState;
  readonly page: number;
  readonly perPage: number;
}

export interface TokenPage {
  readonly tokens: readonly TokenInfo[];
  readonly totalCount: number;
}

export interface AuthorizeTokenCommand {
  readonly presentedToken: string;
  readonly namespaceSlug: string;
  readonly repositoryName: string;
  readonly requiredScope: TokenScope;
}

const tokenState = (row: TokenRow, now: Date): TokenInfo["state"] => {
  if (row.revokedAt !== null) {
    return "revoked";
  }
  return row.expiresAtUnix <= Math.floor(now.getTime() / 1000) ? "expired" : "active";
};

const toTokenInfo = (row: TokenRow, now: Date): TokenInfo => ({
  id: row.id,
  scope: row.scope,
  state: tokenState(row, now),
  created_at: row.createdAt,
  expires_at: row.expiresAt,
});

const stateCondition = (state: TokenListState, nowUnix: number): SQL | undefined => {
  switch (state) {
    case "active":
      return and(isNull(tokens.revokedAt), gt(tokens.expiresAtUnix, nowUnix));
    case "expired":
      return and(isNull(tokens.revokedAt), lte(tokens.expiresAtUnix, nowUnix));
    case "revoked":
      return isNotNull(tokens.revokedAt);
    case "all":
      return undefined;
  }
};

/** Token persistence and checks, colocated with the installation registry. */
export const withTokenRegistry = <TBase extends RegistryStorageConstructor>(Base: TBase) =>
  class TokenRegistryMixin extends Base {
    readonly #db: SyncSqliteDatabase = this[REGISTRY_DATABASE];
    readonly #now: () => Date = this[REGISTRY_NOW];

    async createToken(command: CreateTokenCommand): Promise<CreateTokenOutcome> {
      const now = this.#now();
      const minted = mintToken(now, command.ttlSeconds);
      const secretHash = await hashTokenSecret(minted.secret);

      return this.#db.transaction((tx): CreateTokenOutcome => {
        const repository = tx
          .select({ name: repositories.name })
          .from(repositories)
          .where(
            and(
              eq(repositories.namespaceSlug, command.namespaceSlug),
              eq(repositories.name, command.repositoryName),
            ),
          )
          .limit(1)
          .all();

        if (repository.length === 0) {
          return { created: false, reason: "repository-missing" };
        }

        tx.insert(tokens)
          .values({
            id: minted.id,
            namespaceSlug: command.namespaceSlug,
            repositoryName: command.repositoryName,
            secretHash,
            scope: command.scope,
            createdAt: now.toISOString(),
            expiresAt: minted.expiresAt.toISOString(),
            expiresAtUnix: minted.expiresAtUnix,
            revokedAt: null,
          })
          .run();

        return {
          created: true,
          token: {
            id: minted.id,
            plaintext: minted.plaintext,
            scope: command.scope,
            expires_at: minted.expiresAt.toISOString(),
          },
        };
      });
    }

    async listTokens(
      namespaceSlug: string,
      repositoryName: string,
      query: ListTokensQuery,
    ): Promise<TokenPage | null> {
      const repository = await this.#db
        .select({ name: repositories.name })
        .from(repositories)
        .where(
          and(eq(repositories.namespaceSlug, namespaceSlug), eq(repositories.name, repositoryName)),
        )
        .limit(1);
      if (repository.length === 0) {
        return null;
      }

      const now = this.#now();
      const filter = and(
        eq(tokens.namespaceSlug, namespaceSlug),
        eq(tokens.repositoryName, repositoryName),
        stateCondition(query.state, Math.floor(now.getTime() / 1000)),
      );
      const [rows, totals] = await Promise.all([
        this.#db
          .select()
          .from(tokens)
          .where(filter)
          .orderBy(desc(tokens.createdAt), desc(tokens.id))
          .limit(query.perPage)
          .offset((query.page - 1) * query.perPage),
        this.#db.select({ count: count() }).from(tokens).where(filter),
      ]);

      return {
        tokens: rows.map((row) => toTokenInfo(row, now)),
        totalCount: totals[0]?.count ?? 0,
      };
    }

    async revokeToken(namespaceSlug: string, id: string): Promise<boolean> {
      const rows = await this.#db
        .update(tokens)
        .set({ revokedAt: this.#now().toISOString() })
        .where(and(eq(tokens.namespaceSlug, namespaceSlug), eq(tokens.id, id)))
        .returning({ id: tokens.id });
      return rows.length > 0;
    }

    async authorizeToken(command: AuthorizeTokenCommand): Promise<boolean> {
      const parsed = parseToken(command.presentedToken);
      const nowUnix = Math.floor(this.#now().getTime() / 1000);
      if (parsed === null || (parsed.expiresAtUnix !== null && parsed.expiresAtUnix <= nowUnix)) {
        return false;
      }

      const secretHash = await hashTokenSecret(parsed.secret);
      const rows = await this.#db
        .select()
        .from(tokens)
        .where(eq(tokens.secretHash, secretHash))
        .limit(1);
      const row = rows[0];

      return (
        row !== undefined &&
        row.namespaceSlug === command.namespaceSlug &&
        row.repositoryName === command.repositoryName &&
        row.revokedAt === null &&
        (parsed.expiresAtUnix === null || row.expiresAtUnix === parsed.expiresAtUnix) &&
        row.expiresAtUnix > nowUnix &&
        (command.requiredScope === "read" || row.scope === "write")
      );
    }
  };

export class TokenRegistry extends withTokenRegistry(LocalRegistryStorage) {}

export type TokenRegistryClient = Pick<TokenRegistry, Extract<keyof TokenRegistry, string>>;
