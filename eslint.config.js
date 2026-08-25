import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "drizzle/**", "coverage/**", "load/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-restricted-syntax": [
        "error",
        { "selector": "TSAsExpression > TSTypeReference > Identifier[name='never']", "message": "Avoid 'as never' — type the boundary properly." }
      ]
    }
  },
  // Test/script code may use assertions for brevity — last match wins in flat config.
  {
    files: ["tests/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-restricted-syntax": "off"
    }
  }
);