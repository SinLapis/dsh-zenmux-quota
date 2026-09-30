/**
 * Build script for dsh-zenmux-quota.
 *
 * Produces two artifacts:
 *
 *  - `lib/index.js` — the Node half as plain ESM, so the Cordis Loader can
 *    import it and therefore discover this package's `dsh.client` declaration.
 *  - `lib/client.js` — the browser half. This MUST be a
 *    `window.__ModuleLoader__.load({ id, factory })` CJS-factory registration;
 *    an ordinary ESM bundle or a standalone Vite page cannot be consumed by the
 *    DSH client module system. The bundler emits the factory body as CommonJS
 *    with React and every DSH package left external, and this script wraps the
 *    result in the loader envelope.
 *
 * Run with `node scripts/build.mjs`.
 *
 * The bundler is invoked through its platform-native executable rather than its
 * JavaScript API. That is not a style preference: the JS API starts a long-lived
 * service child over piped stdio, which several confined sandboxes refuse with
 * `EPERM`. The native binary accepts the same options on the command line and
 * needs no pipe.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'lib')
const clientOut = join(outDir, 'client.js')

/** The one entry the browser half hangs off: a stable, package-name-derived id. */
const CLIENT_ID = 'dsh-zenmux-quota'

/**
 * Modules the host shell already owns.
 *
 * Everything here arrives through the `factory(require)` argument, which is the
 * DSH client module system's shared instance — never a second copy. Bundling any
 * of them would ship a duplicate React (the classic dual-React crash) or a second
 * cordis context type.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-renderer/client',
  '@deepseek-ai/dsh-client-ui-conversation/client',
  '@deepseek-ai/dsh-client-ui-model-selection/client',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-session/types',
]

/**
 * Locate the platform-native bundler executable.
 *
 * The JavaScript wrapper starts a long-lived service child over piped stdio,
 * which confined sandboxes refuse with `EPERM`; the native executable takes the
 * same work as plain argv and needs no pipe. pnpm keeps the platform package
 * inside the wrapper's own virtual-store directory, so resolution is anchored at
 * the wrapper's manifest rather than at this script.
 *
 * @returns the absolute path of the native executable.
 * @throws when no platform binary is installed.
 */
function resolveEsbuildBinary() {
  const require = createRequire(import.meta.url)
  const wrapper = require.resolve('esbuild/package.json')
  const anchored = createRequire(wrapper)
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`
  const executableName = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'

  const candidates = []
  try {
    candidates.push(join(dirname(anchored.resolve(`${platformPackage}/package.json`)), executableName))
  } catch {
    // Fall through to the virtual-store scan below.
  }
  // pnpm's virtual store is the layout that actually ships with a real install;
  // the direct resolve above covers npm and a hoisted tree.
  const virtualStore = join(root, 'node_modules/.pnpm')
  if (existsSync(virtualStore)) {
    for (const entry of readdirSync(virtualStore)) {
      if (!entry.startsWith('@esbuild+')) continue
      candidates.push(join(virtualStore, entry, 'node_modules', platformPackage, executableName))
    }
  }

  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) {
    throw new Error(`no native esbuild binary found; looked in:\n  ${candidates.join('\n  ')}`)
  }
  return found
}

/**
 * Wrap a CommonJS factory body in the DSH loader envelope.
 *
 * The envelope mirrors what `dsh-codex` and `dsh-workbuddy-connect` ship: a
 * `module`/`exports` pair per factory, the ESM `Symbol.toStringTag`, and the
 * materialized `module.exports` as the return value.
 *
 * @param body - the CommonJS factory body emitted by the bundler.
 * @returns the complete `window.__ModuleLoader__.load(...)` script.
 */
function wrapClient(body) {
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(CLIENT_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
\t\treturn module.exports;
\t}
});
`
}

/**
 * Drop the bundler's ESM-interop preamble.
 *
 * The Loader stores `module.exports` verbatim, so the marker is harmless, but the
 * shipped artifact is kept byte-identical in shape to the other DSH UI plugins.
 *
 * @param body - raw CommonJS factory body.
 * @returns the body without the leading `"use strict";` line.
 */
function stripEsmMarker(body) {
  return body.replace(/^"use strict";\r?\n/, '')
}

/**
 * Indent a bundle so it sits neatly inside the factory closure.
 * @param body - the bundle text.
 * @returns the text with one extra leading tab per line.
 */
function indent(body) {
  return body
    .split('\n')
    .map(line => (line.length === 0 ? line : `\t\t${line}`))
    .join('\n')
}

/**
 * Format one repeatable CLI option.
 *
 * Flags that may be specified more than once use `--flag:value`; the CLI rejects
 * both `--flag value` (read as a second positional argument) and `--flag=value`
 * for these.
 *
 * @param name - option name including its leading dashes.
 * @param value - option value.
 * @returns the single joined argv entry.
 */
function repeatable(name, value) {
  return `${name}:${value}`
}

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(join(outDir, 'types'), { recursive: true })

  const esbuild = resolveEsbuildBinary()

  // Node half: the host plugin is bundled from src/ with every package external,
  // so the Loader imports one ESM file and resolves dependencies from the profile.
  execFileSync(esbuild, [
    join(root, 'src/index.ts'),
    '--bundle',
    '--packages=external',
    '--format=esm',
    '--platform=node',
    '--target=node22',
    '--outfile=lib/index.js',
    '--log-level=warning',
  ], { cwd: root, stdio: 'inherit' })
  // Browser half: one self-contained CommonJS factory with host modules external.
  const clientArgs = [
    join(root, 'src/client/index.tsx'),
    '--bundle',
    '--format=cjs',
    '--platform=browser',
    '--target=es2022',
    '--jsx=automatic',
    '--charset=utf8',
    '--log-level=warning',
    '--outfile=lib/client.js.tmp',
    ...CLIENT_EXTERNALS.map(name => repeatable('--external', name)),
  ]
  execFileSync(esbuild, clientArgs, { cwd: root, stdio: 'inherit' })

  const raw = await readFile(join(outDir, 'client.js.tmp'), 'utf8')
  const body = stripEsmMarker(raw).trimEnd()
  await writeFile(clientOut, wrapClient(indent(body)), 'utf8')
  await rm(join(outDir, 'client.js.tmp'), { force: true })

  // Type declarations for the Node half only. The browser half is consumed by
  // the module loader, which never reads types.
  await writeFile(
    join(outDir, 'types/index.d.ts'),
    [
      "import type { Context } from '@deepseek-ai/cordis';",
      '/** Stable host plugin name. */',
      `export declare const name = "${CLIENT_ID}";`,
      'export type ZenMuxDisplayMode = "binding" | "five-hour" | "weekly" | "dual";',
      'export interface Config {',
      '  managementKeyEnv?: string;',
      '  providers?: string[];',
      '  providerPattern?: string;',
      '  display?: ZenMuxDisplayMode;',
      '  cacheTtlSeconds?: number;',
      '  baseURL?: string;',
      '}',
      'export declare const Config: unknown;',
      '/** Register the quota routes once the web server is available. */',
      'export declare function apply(ctx: Context, config: Config): void;',
      '',
    ].join('\n'),
    'utf8',
  )
  const written = await readFile(clientOut, 'utf8')
  if (!written.startsWith('window.__ModuleLoader__.load({')) {
    throw new Error('client bundle is not wrapped in the DSH module-loader envelope')
  }
  process.stdout.write('built lib/index.js, lib/client.js, lib/types/index.d.ts\n')
}

await main()
