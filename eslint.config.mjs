// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** UI and rendering modules the pure layers must never reach. */
const UI = ['react', 'react-dom', 'react/*', 'react-dom/*', 'three', 'three/*', '@react-three/*'];

/**
 * The layering in `.claude/CLAUDE.md` ("dependencies point inward"), enforced.
 * Each entry lists the workspace packages a package's *source* may not import.
 * Tests and benches are exempt: they may load fixtures through other packages.
 */
const LAYERS = {
  kernel: { pkgs: ['io', 'units', 'store', 'render2d', 'render3d', 'export', 'ui'], ui: true },
  units: { pkgs: ['kernel', 'io', 'store', 'render2d', 'render3d', 'export', 'ui'], ui: true },
  io: { pkgs: ['units', 'store', 'render2d', 'render3d', 'export', 'ui'], ui: true },
  export: { pkgs: ['io', 'units', 'store', 'render2d', 'render3d', 'ui'], ui: true },
  store: { pkgs: ['io', 'units', 'render2d', 'render3d', 'export', 'ui'], ui: true },
  render2d: { pkgs: ['io', 'units', 'render3d', 'export'], ui: false },
  render3d: { pkgs: ['io', 'units', 'render2d', 'export', 'ui'], ui: false },
  ui: { pkgs: ['kernel', 'io', 'units', 'store', 'render2d', 'render3d', 'export'], ui: false },
};

const layerConfigs = Object.entries(LAYERS).map(([name, { pkgs, ui }]) => ({
  files: [`packages/${name}/src/**/*.{ts,tsx}`],
  ignores: ['**/*.test.{ts,tsx}', '**/*.bench.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: pkgs.map((p) => `@openshaper/${p}`),
            message: `@openshaper/${name} may not depend on this package (see the layering in .claude/CLAUDE.md).`,
          },
          ...(ui
            ? [
                {
                  group: UI,
                  message: `@openshaper/${name} is a pure layer: no React, DOM or three.js.`,
                },
              ]
            : []),
        ],
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/target/',
      '**/test-results/',
      '**/playwright-report/',
      'apps/desktop/src-tauri/',
      'apps/web/pw.local*.config.ts',
      'docs/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The two classic hooks rules. The plugin's newer React Compiler rules are
      // not enabled: the app does not use the compiler.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      // Ported code mirrors the legacy Java: locals are declared with a value and
      // assigned later. Harmless, and rewriting kernel ports for style is churn.
      'no-useless-assignment': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  ...layerConfigs,
);
