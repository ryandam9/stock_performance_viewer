const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    js.configs.recommended,
    {
        // Browser app code (classic scripts, no bundler).
        files: ["app.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: {
                ...globals.browser,
                Plotly: "readonly",
                initSqlJs: "readonly",
            },
        },
        rules: {
            "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
            "no-empty": ["error", { allowEmptyCatch: true }],
        },
    },
    {
        // Shared library — runs in both browser and Node.
        files: ["lib.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: { ...globals.browser, ...globals.node },
        },
        rules: {
            "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
            "no-empty": ["error", { allowEmptyCatch: true }],
        },
    },
    {
        // Node-context config / tooling files.
        files: ["eslint.config.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: { ...globals.node },
        },
    },
    {
        // Test files (Vitest / ESM).
        files: ["test/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: { ...globals.node },
        },
    },
    {
        ignores: ["node_modules/**"],
    },
];
