import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...["security", "shared", "agent"].map(pkg => {
    const forbidden = pkg === "shared" ? ["agent","security","web"] : pkg === "security" ? ["agent","web"] : ["security","web"];
    return {
      files: [`packages/${pkg}/src/**/*.{js,mjs,ts,tsx}`],
      rules: { "no-restricted-imports": ["error", { patterns: forbidden.map(name => ({
        group:[`@solguard/${name}`,`@solguard/${name}/**`,`**/${name}/**`],
        message:`${pkg} runtime must not depend on ${name}. Use @solguard/shared contracts.`,
      })) }] },
    };
  }),
  {
    files: ["packages/security/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["packages/shared/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  }
);
