import { DurableObject } from "cloudflare:workers";

/**
 * Reserved Durable Object boundary for the Git engine.
 *
 * Persistence and Git behavior deliberately do not live here yet. Keeping the
 * class deployed now gives future engine work a stable SQLite-backed namespace
 * without pretending that any repository operations already exist.
 */
export class RepositoryObject extends DurableObject {
  override async fetch(): Promise<Response> {
    return Response.json(
      {
        type: "https://open-relic.dev/problems/not-implemented",
        title: "Not Implemented",
        status: 501,
        detail: "The repository Durable Object has not been implemented.",
      },
      {
        status: 501,
        headers: { "Content-Type": "application/problem+json" },
      },
    );
  }
}
