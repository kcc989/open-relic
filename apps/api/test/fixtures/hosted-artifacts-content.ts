/**
 * Direct responses from Cloudflare Artifacts on 2026-08-14.
 *
 * The probes created disposable repositories in the `default` namespace. One
 * pushed Open Relic's `origin/main` at 6615e0c for blob and error responses;
 * two synthetic Git histories pinned commit-message and tree-mode behavior.
 * Every repository was deleted, and no API or repository token is retained.
 */

export const HOSTED_COMMIT_FIXTURE = {
  status: 200,
  body: {
    result: {
      hash: "1820e25270b79e4a02d9f11cfd01911a0d0d0453",
      treeHash: "03b1fb43f4efeecd19aecf45422e612e825314ef",
      message: "  leading spaces\nbody trailing spaces  \n",
      author: { name: "Edge Case", email: "edge@example.com" },
      committer: { name: "Edge Case", email: "edge@example.com" },
      parents: [],
      authoredAt: 1_767_225_600,
      committedAt: 1_767_225_601,
    },
    success: true,
    errors: [],
    messages: [],
  },
} as const;

export const HOSTED_TREE_FIXTURE = {
  status: 200,
  body: {
    result: [
      {
        name: "dir",
        mode: "40000",
        hash: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        type: "tree",
      },
      {
        name: "file",
        mode: "100644",
        hash: "54aeb5dc2537483ba853f1b52ed0bdc20e0193c8",
        type: "blob",
      },
      {
        name: "link",
        mode: "120000",
        hash: "eb5a316cbd195d26e3f768c7dd8e1b47299e17f8",
        type: "symlink",
      },
      {
        name: "run",
        mode: "100755",
        hash: "54aeb5dc2537483ba853f1b52ed0bdc20e0193c8",
        type: "exec",
      },
      {
        name: "vendor",
        mode: "160000",
        hash: "2222222222222222222222222222222222222222",
        type: "gitlink",
      },
    ],
    success: true,
    errors: [],
    messages: [],
  },
} as const;

export const HOSTED_BLOB_FIXTURE = {
  status: 200,
  contentType: "application/octet-stream",
  bytes: 34_395,
  gitBlobOid: "1c80a4c0f056b7d413160d6479013abd21b6160b",
} as const;

export const HOSTED_MALFORMED_HASH_FIXTURE = {
  status: 400,
  body: {
    result: null,
    success: false,
    errors: [
      {
        code: 10_100,
        message: "Invalid SHA-1 hash",
        documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10100",
        source: { pointer: "/hash" },
      },
    ],
    messages: [],
  },
} as const;

export const HOSTED_MISSING_OBJECT_FIXTURES = {
  commit: {
    status: 404,
    body: {
      result: null,
      success: false,
      errors: [
        {
          code: 10_200,
          message: "Commit not found",
          documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10200",
        },
      ],
      messages: [],
    },
  },
  tree: {
    status: 404,
    body: {
      result: null,
      success: false,
      errors: [
        {
          code: 10_200,
          message: "Tree not found",
          documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10200",
        },
      ],
      messages: [],
    },
  },
  blob: {
    status: 404,
    body: {
      result: null,
      success: false,
      errors: [
        {
          code: 10_200,
          message: "Blob not found",
          documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10200",
        },
      ],
      messages: [],
    },
  },
} as const;

export const HOSTED_WRONG_OBJECT_FIXTURES = {
  commit: {
    status: 500,
    body: {
      result: null,
      success: false,
      errors: [
        {
          code: 10_400,
          message: "A stored git object is corrupt.",
          documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10400",
        },
      ],
      messages: [],
    },
  },
  tree: {
    status: 500,
    body: {
      result: null,
      success: false,
      errors: [
        {
          code: 10_400,
          message: "A stored git object is corrupt.",
          documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10400",
        },
      ],
      messages: [],
    },
  },
  blob: {
    status: 404,
    body: {
      result: null,
      success: false,
      errors: [
        {
          code: 10_200,
          message: "Blob not found",
          documentation_url: "https://developers.cloudflare.com/artifacts/api/errors#10200",
        },
      ],
      messages: [],
    },
  },
} as const;
