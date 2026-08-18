import tseslint from "typescript-eslint";

/**
 * 目前只做一件事：把《14-UI规范与方案》§11.3 / §15.1 那条「禁止浏览器原生弹窗」
 * 从人肉 code review 变成 CI 能拦住的规则。别的代码风格暂不在这里管，
 * 以后要加规则往下追加即可。
 */
export default tseslint.config(
  { ignores: ["**/dist/**", "**/build/**", "**/node_modules/**", "**/*.d.ts", "themes/**", "artifacts/**"] },
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    rules: {
      // 覆盖 alert() / confirm() / prompt() 以及 window.* 形式。
      "no-alert": "error",
      "no-restricted-properties": [
        "error",
        { object: "window", property: "alert", message: "禁止原生弹窗：用 useToast() 提示，见 docs/设计/14-UI规范与方案.md §11.3。" },
        { object: "window", property: "confirm", message: "禁止原生弹窗：用 useConfirm() 确认，见 docs/设计/14-UI规范与方案.md §11.3。" },
        { object: "window", property: "prompt", message: "禁止原生弹窗：用 usePrompt() 收输入，见 docs/设计/14-UI规范与方案.md §11.3。" },
      ],
    },
  },
);
