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
 * An entry may name its own `files` and extra `ignores` when one package has two
 * layers (board2's core and its classic converter).
 */
const LAYERS = {
  kernel: {
    pkgs: ['io', 'units', 'store', 'render2d', 'render3d', 'export', 'ui', 'geom', 'board2'],
    ui: true,
  },
  units: {
    pkgs: ['kernel', 'io', 'store', 'render2d', 'render3d', 'export', 'ui', 'geom', 'board2'],
    ui: true,
  },
  io: {
    pkgs: ['units', 'store', 'render2d', 'render3d', 'export', 'ui', 'geom', 'board2'],
    ui: true,
  },
  export: {
    pkgs: ['io', 'units', 'store', 'render2d', 'render3d', 'ui', 'geom', 'board2'],
    ui: true,
  },
  store: {
    pkgs: ['io', 'units', 'render2d', 'render3d', 'export', 'ui', 'geom', 'board2'],
    ui: true,
  },
  render2d: { pkgs: ['io', 'units', 'render3d', 'export', 'geom', 'board2'], ui: false },
  render3d: { pkgs: ['io', 'units', 'render2d', 'export', 'ui', 'geom', 'board2'], ui: false },
  ui: {
    pkgs: ['kernel', 'io', 'units', 'store', 'render2d', 'render3d', 'export', 'geom', 'board2'],
    ui: false,
  },
  // The NURBS core of the geometry overhaul (docs/design/geom-core.md §2): pure,
  // standalone, and no `node:*` either. Only board2 may import it (granted in
  // Phase 2, docs/design/board2.md §11.3); `geom` is listed in every other entry.
  geom: {
    pkgs: ['kernel', 'io', 'units', 'store', 'render2d', 'render3d', 'export', 'ui', 'board2'],
    ui: true,
    node: true,
    // Test-only oracles (geom-core.md §2): devDependencies, never shipped.
    extra: [
      {
        group: [
          'delaunator',
          '@kninnug/constrainautor',
          'occt-wasm',
          './testing',
          './testing/*',
          '../testing',
          '../testing/*',
          '@openshaper/geom/testing',
        ],
        message:
          'Test-only oracle or helper: import it from tests and benches only, never from src.',
      },
    ],
    // The OCCT protocol module has its own entry below.
    ignores: ['packages/geom/src/testing/occt/**'],
  },
  // The OCCT protocol (`@openshaper/geom/testing/occt`, docs/design/board2.md
  // §14 S4): test-only, run by `*.occt.test.ts` files of any package. The one
  // source file allowed to import `occt-wasm` (occt-isolation.test.ts checks
  // that nothing shipping reaches it); otherwise geom's rules.
  'geom/testing/occt': {
    files: ['packages/geom/src/testing/occt/**/*.{ts,tsx}'],
    pkgs: ['kernel', 'io', 'units', 'store', 'render2d', 'render3d', 'export', 'ui', 'board2'],
    ui: true,
    node: true,
    extra: [
      {
        group: ['delaunator', '@kninnug/constrainautor', '@openshaper/geom/testing'],
        message: 'The OCCT protocol uses geom through relative imports and occt-wasm only.',
      },
    ],
  },
  // The v2 board model (docs/design/board2.md §11.3). Its core may import
  // `@openshaper/geom` and nothing else of the workspace; the classic converter
  // (`src/classic/`, the entry below) is the only part allowed to reach the
  // kernel, and the core may not import it. `test-support/` holds test-only
  // loaders (sample files through io, `node:fs`) and is exempt like tests.
  board2: {
    pkgs: ['kernel', 'io', 'units', 'store', 'render2d', 'render3d', 'export', 'ui'],
    ui: true,
    node: true,
    ignores: ['packages/board2/src/classic/**', '**/test-support/**'],
    extra: [
      {
        group: [
          './classic',
          './classic/*',
          '../classic',
          '../classic/*',
          '@openshaper/board2/classic',
        ],
        message:
          'The board2 core may not import the classic converter (docs/design/board2.md §11.3).',
      },
      {
        group: [
          './testing',
          './testing/*',
          '../testing',
          '../testing/*',
          '@openshaper/board2/testing',
          '@openshaper/geom/testing',
          '@openshaper/geom/testing/*',
        ],
        message: 'Test-only helper: import it from tests and benches only, never from src.',
      },
    ],
  },
  'board2/classic': {
    files: ['packages/board2/src/classic/**/*.{ts,tsx}'],
    pkgs: ['io', 'units', 'store', 'render2d', 'render3d', 'export', 'ui'],
    ui: true,
    node: true,
    ignores: ['**/test-support/**'],
    extra: [
      {
        group: [
          '../testing',
          '../testing/*',
          '@openshaper/board2/testing',
          '@openshaper/geom/testing',
          '@openshaper/geom/testing/*',
        ],
        message: 'Test-only helper: import it from tests and benches only, never from src.',
      },
    ],
  },
};

const layerConfigs = Object.entries(LAYERS).map(
  ([name, { pkgs, ui, node = false, extra = [], files, ignores = [] }]) => ({
    files: files ?? [`packages/${name}/src/**/*.{ts,tsx}`],
    ignores: ['**/*.test.{ts,tsx}', '**/*.bench.ts', ...ignores],
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
            ...extra,
          ],
        },
      ],
    },
  }),
);

/**
 * The apps are not in LAYERS (they may use every package above), except the
 * experiment's NURBS core and board model, which nothing outside their own phase
 * plan may reach yet.
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
            {
              group: ['@openshaper/board2', '@openshaper/board2/*'],
              message:
                '@openshaper/board2 is not wired into the apps yet (docs/design/geometry-overhaul.md §5).',
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
