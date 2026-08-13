import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: ["tools/oxlint/**", "apps/*/drizzle/**", ".agents/**", ".claude/**"],
});
