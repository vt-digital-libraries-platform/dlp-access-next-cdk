import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // AWS Lambda code, deployed separately (see src/app/_lambda/README.md)
    "src/app/_lambda/**",
    // CDK synth output, including bundled Lambda assets.
    "infra/cdk.out/**",
  ]),
]);

export default eslintConfig;
