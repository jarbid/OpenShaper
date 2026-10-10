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
  kernel: {
    pkgs: ['io', 'units', 'store', 'render2d', 'render3d', 'export', 'ui', 'geom'],
    ui: true,
  },
  units: {
    pkgs: ['kernel', 'io', 'store', 'render2d', 'render3d', 'export', 'ui', 'geom'],
    ui: true,
  },
  io: { pkgs: ['units', 'store', 'render2d', 'render3d', 'export', 'ui', 'geom'], ui: true },
  export: { pkgs: ['io', 'units', 'store', 'render2d', 'render3d', 'ui', 'geom'], ui: true },
  store: { pkgs: ['io', 'units', 'render2d', 'render3d', 'export', 'ui', 'geom'], ui: true },
  render2d: { pkgs: ['io', 'units', 'render3d', 'export', 'geom'], ui: false },
  render3d: { pkgs: ['io', 'units', 'render2d', 'export', 'ui', 'geom'], ui: false },
  ui: {
    pkgs: ['kernel', 'io', 'units', 'store', 'render2d', 'render3d', 'export', 'geom'],
    ui: false,
  },
  // The NURBS core of the geometry overhaul (docs/design/geom-core.md §2): pure,
  // standalone, and no `node:*` either. No other package may import it yet
  // (`geom` is listed in every entry above); a later phase grants that explicitly.
  geom: {
    pkgs: ['kernel', 'io', 'units', 'store', 'render2d', 'render3d', 'export', 'ui'],
    ui: true,
    node: true,
  },
};

const layerConfigs = Object.entries(LAYERS).map(([name, { pkgs, ui, node = false }]) => ({
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
          ...(node
            ? [
                {
                  group: ['node:*'],
                  message: `@openshaper/${name} is a pure layer: no Node built-ins outside tests.`,
                },
              ]
            : []),
        ],
      },
    ],
  },
}));

/**
 * The apps are not in LAYERS (they may use every package above), except the
 * experiment's NURBS core, which nothing outside its own phase plan may reach yet.
 */
const appConfigs = [
  {
    files: ['apps/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.bench.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@openshaper/geom', '@openshaper/geom/*'],
              message:
                '@openshaper/geom is not wired into the apps yet (docs/design/geometry-overhaul.md §5).',
            },
          ],
        },
      ],
    },
  },
];

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
  ...appConfigs,
);
