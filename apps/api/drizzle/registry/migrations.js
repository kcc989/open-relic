import m0000 from "./20260813152714_namespaces/migration.sql";
import m0001 from "./20260813195517_repositories/migration.sql";
import m0002 from "./20260813222304_tokens/migration.sql";
import m0003 from "./20260814010748_aromatic_killer_shrike/migration.sql";

export default {
  migrations: {
    "20260813152714_namespaces": m0000,
    "20260813195517_repositories": m0001,
    "20260813222304_tokens": m0002,
    "20260814010748_aromatic_killer_shrike": m0003,
  },
};
