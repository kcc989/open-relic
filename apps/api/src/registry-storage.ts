import type { SyncSqliteDatabase } from "./db/database.ts";

export const REGISTRY_DATABASE = Symbol("registryDatabase");
export const REGISTRY_NOW = Symbol("registryNow");

export interface RegistryStorage {
  readonly [REGISTRY_DATABASE]: SyncSqliteDatabase;
  readonly [REGISTRY_NOW]: () => Date;
}

export type RegistryStorageConstructor = new (...args: any[]) => RegistryStorage;

export class LocalRegistryStorage implements RegistryStorage {
  readonly [REGISTRY_DATABASE]: SyncSqliteDatabase;
  readonly [REGISTRY_NOW]: () => Date;

  constructor(db: SyncSqliteDatabase, now: () => Date = () => new Date()) {
    this[REGISTRY_DATABASE] = db;
    this[REGISTRY_NOW] = now;
  }
}
