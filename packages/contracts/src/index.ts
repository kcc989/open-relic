export const API_BASE_PATH = "/api/v1" as const;

export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST";

export interface EndpointContract {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly samplePath: string;
}

export const REST_ENDPOINTS = [
  {
    id: "namespaces.create",
    method: "POST",
    path: `${API_BASE_PATH}/namespaces`,
    samplePath: `${API_BASE_PATH}/namespaces`,
  },
  {
    id: "namespaces.list",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces`,
    samplePath: `${API_BASE_PATH}/namespaces`,
  },
  {
    id: "namespaces.get",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace`,
    samplePath: `${API_BASE_PATH}/namespaces/acme`,
  },
  {
    id: "namespaces.delete",
    method: "DELETE",
    path: `${API_BASE_PATH}/namespaces/:namespace`,
    samplePath: `${API_BASE_PATH}/namespaces/acme`,
  },
  {
    id: "repositories.create",
    method: "POST",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos`,
  },
  {
    id: "repositories.list",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos`,
  },
  {
    id: "repositories.get",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo`,
  },
  {
    id: "repositories.update",
    method: "PATCH",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo`,
  },
  {
    id: "repositories.delete",
    method: "DELETE",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo`,
  },
  {
    id: "repositories.fork",
    method: "POST",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/fork`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/fork`,
  },
  {
    id: "repositories.import",
    method: "POST",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/import`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/import`,
  },
  {
    id: "tokens.create",
    method: "POST",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/tokens`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/tokens`,
  },
  {
    id: "tokens.list",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/tokens`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/tokens`,
  },
  {
    id: "tokens.delete",
    method: "DELETE",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/tokens/:tokenId`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/tokens/token-1`,
  },
  {
    id: "contents.refs",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/refs`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/refs`,
  },
  {
    id: "contents.log",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/log`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/log`,
  },
  {
    id: "contents.commit",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/commits/:hash`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/commits/deadbeef`,
  },
  {
    id: "contents.tree",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/trees/:hash`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/trees/deadbeef`,
  },
  {
    id: "contents.blob",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/blobs/:hash`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/blobs/deadbeef`,
  },
  {
    id: "contents.file",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/files/*`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/files/src/index.ts?ref=main`,
  },
  {
    id: "contents.archive",
    method: "GET",
    path: `${API_BASE_PATH}/namespaces/:namespace/repos/:repo/archive/*`,
    samplePath: `${API_BASE_PATH}/namespaces/acme/repos/demo/archive/main.tar.gz`,
  },
] as const satisfies readonly EndpointContract[];

export const GIT_HTTP_ENDPOINTS = [
  {
    id: "git.uploadPack.advertise",
    method: "GET",
    path: "/git/:namespace/:repo.git/info/refs",
    samplePath: "/git/acme/demo.git/info/refs?service=git-upload-pack",
  },
  {
    id: "git.uploadPack",
    method: "POST",
    path: "/git/:namespace/:repo.git/git-upload-pack",
    samplePath: "/git/acme/demo.git/git-upload-pack",
  },
  {
    id: "git.receivePack.advertise",
    method: "GET",
    path: "/git/:namespace/:repo.git/info/refs",
    samplePath: "/git/acme/demo.git/info/refs?service=git-receive-pack",
  },
  {
    id: "git.receivePack",
    method: "POST",
    path: "/git/:namespace/:repo.git/git-receive-pack",
    samplePath: "/git/acme/demo.git/git-receive-pack",
  },
] as const satisfies readonly EndpointContract[];

export const HTTP_ENDPOINTS = [
  ...REST_ENDPOINTS,
  ...GIT_HTTP_ENDPOINTS,
] as const;

export type EndpointId = (typeof HTTP_ENDPOINTS)[number]["id"];

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly operation?: EndpointId;
}
