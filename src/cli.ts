#!/usr/bin/env node

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig } from './config.js'
import { createPool, loadDatabaseConfig } from './db/pool.js'
import { loadCodexRegistry, reconcileCodexRegistry } from './db/project-registry.js'
import {
  loadProjectSupersessionManifest,
  reconcileProjectSupersessions
} from './db/project-supersession.js'
import { migrateRuntimeDatabase, startRuntime } from './runtime.js'
import { launchdDatabaseEnvironment, renderLaunchdPlist } from './platform/launchd.js'
import { installLaunchdService } from './platform/launchd-service.js'
import { ensureLanMrCertificates } from './platform/lan-mr-certificates.js'
import { loadLanMrConfig } from './platform/lan-mr-config.js'
import { platformPaths } from './platform/paths.js'
import { openQuestInspector } from './platform/quest-inspector.js'
import { LanMrPairingAuthority } from './gateway/lan-mr-auth.js'
import { startLanMrRuntime } from './lan-mr-runtime.js'

const command = process.argv[2] ?? 'help'

try {
  switch (command) {
    case 'serve':
      await serve()
      break
    case 'migrate':
      await migrateRuntimeDatabase()
      console.log('Boron Context database migrations are current.')
      break
    case 'health':
      await health()
      break
    case 'reconcile-codex-projects':
    case 'reconcile-projects':
      await reconcileProjects()
      break
    case 'repair-project-identities':
      await repairProjectIdentities()
      break
    case 'print-launchd':
      printLaunchd()
      break
    case 'install-launchd':
      await installLaunchd()
      break
    case 'quest-inspector':
      await questInspector()
      break
    case 'lan-inspector':
      await lanInspector()
      break
    case 'help':
    case '--help':
    case '-h':
      help()
      break
    default:
      throw new Error(`Unknown command: ${command}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function serve(): Promise<void> {
  const runtime = await startRuntime()
  console.log(`Boron Context listening at ${runtime.gateway.url}`)
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await runtime.close()
  }
  process.once('SIGINT', () => void stop().then(() => process.exit(0)))
  process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
}

async function health(): Promise<void> {
  const config = loadConfig()
  const response = await fetch(`http://${config.host}:${config.port}/health`)
  const body = await response.text()
  console.log(body)
  if (!response.ok) process.exitCode = 1
}

async function reconcileProjects(): Promise<void> {
  const manifestPath = optionValue('--manifest')
  if (!manifestPath) {
    throw new Error(`${command} requires --manifest <path>`)
  }
  const statePath = optionValue('--state') ?? join(homedir(), '.codex', '.codex-global-state.json')
  const registry = await loadCodexRegistry({
    statePath: resolve(statePath),
    manifestPath: resolve(manifestPath)
  })
  const pool = createPool(loadDatabaseConfig())
  try {
    const result = await reconcileCodexRegistry(pool, registry, process.argv.includes('--apply'))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await pool.end()
  }
}

async function repairProjectIdentities(): Promise<void> {
  const manifestPath = optionValue('--manifest')
  if (!manifestPath) {
    throw new Error('repair-project-identities requires --manifest <path>')
  }
  const loaded = await loadProjectSupersessionManifest(resolve(manifestPath))
  const pool = createPool(loadDatabaseConfig())
  try {
    const result = await reconcileProjectSupersessions(
      pool,
      { manifest: loaded.manifest, manifestUri: loaded.uri },
      process.argv.includes('--apply')
    )
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await pool.end()
  }
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function printLaunchd(): void {
  process.stdout.write(launchdDefinition())
}

async function installLaunchd(): Promise<void> {
  const paths = platformPaths('darwin')
  const result = await installLaunchdService({
    label: 'dev.boroncontext.daemon',
    plist: launchdDefinition(),
    logDirectory: paths.logDirectory
  })
  console.log(`Installed ${result.label} at ${result.plistPath}`)
}

async function questInspector(): Promise<void> {
  const serial = optionValue('--serial')
  const result = await openQuestInspector({
    ...(serial ? { serial } : {}),
    stop: process.argv.includes('--stop')
  })
  if (result.stopped) {
    console.log(`Removed the Boron Inspector reverse connection from ${result.serial}.`)
  } else {
    console.log(
      `Opened the authenticated Boron Spatial Inspector on ${result.serial}. The daemon remains loopback-only.`
    )
  }
}

async function lanInspector(): Promise<void> {
  const action = process.argv[3] ?? 'pair'
  switch (action) {
    case 'serve':
      await serveLanInspector()
      return
    case 'install':
      await installLanInspector()
      return
    case 'pair':
      await printLanPairing()
      return
    default:
      throw new Error(`Unknown lan-inspector action: ${action}`)
  }
}

async function serveLanInspector(): Promise<void> {
  const runtime = await startLanMrRuntime()
  console.log(
    `Boron LAN MR bootstrap at ${runtime.gateway.bootstrapUrl}; paired HTTPS at ${runtime.gateway.secureUrl}`
  )
  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await runtime.close()
  }
  process.once('SIGINT', () => void stop().then(() => process.exit(0)))
  process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
}

async function installLanInspector(): Promise<void> {
  const paths = platformPaths('darwin')
  const config = loadLanMrConfig()
  await prepareLanInspector(config)
  const result = await installLaunchdService({
    label: 'dev.boroncontext.lan-mr',
    plist: lanMrLaunchdDefinition(config),
    logDirectory: paths.logDirectory
  })
  await waitForLanBootstrap(config)
  console.log(`Installed ${result.label} at ${result.plistPath}`)
  await printLanPairing(config)
}

async function printLanPairing(config = loadLanMrConfig()): Promise<void> {
  const certificates = await prepareLanInspector(config)
  const pairing = await LanMrPairingAuthority.create({
    pairingSecretPath: join(config.stateDirectory, 'pairing.secret'),
    sessionSecretPath: join(config.stateDirectory, 'session.secret')
  })
  const current = pairing.currentPairing()
  console.log(`Quest bootstrap: http://${config.host}:${config.bootstrapPort}`)
  console.log(`Quest HTTPS: https://${config.host}:${config.httpsPort}/pair`)
  console.log(`Bonjour HTTPS: https://${config.hostname}:${config.httpsPort}/pair`)
  console.log(`CA SHA-256: ${certificates.caFingerprint256}`)
  console.log(`One-time pairing code: ${current.code} (expires ${current.expiresAt})`)
}

async function prepareLanInspector(config = loadLanMrConfig()) {
  const certificates = await ensureLanMrCertificates({
    directory: config.certificateDirectory,
    host: config.host,
    hostname: config.hostname,
    opensslCommand: config.opensslCommand
  })
  await LanMrPairingAuthority.create({
    pairingSecretPath: join(config.stateDirectory, 'pairing.secret'),
    sessionSecretPath: join(config.stateDirectory, 'session.secret')
  })
  return certificates
}

async function waitForLanBootstrap(config: ReturnType<typeof loadLanMrConfig>): Promise<void> {
  const url = `http://${config.host}:${config.bootstrapPort}/health`
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // launchd may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`Boron LAN MR did not become healthy at ${url}`)
}

function launchdDefinition(): string {
  const paths = platformPaths('darwin')
  const projectRoot = process.cwd()
  const config = loadConfig()
  return renderLaunchdPlist({
    label: 'dev.boroncontext.daemon',
    nodePath: process.execPath,
    cliPath: resolve(projectRoot, 'dist', 'cli.js'),
    workingDirectory: projectRoot,
    stdoutPath: resolve(paths.logDirectory, 'daemon.stdout.log'),
    stderrPath: resolve(paths.logDirectory, 'daemon.stderr.log'),
    environment: {
      BORON_HOST: config.host,
      BORON_PORT: String(config.port),
      BORON_TOKEN_FILE: config.tokenPath,
      BORON_OPENWIKI_ROOT: config.openWikiRoot,
      BORON_CODEBASE_MEMORY_GRAPH_URL: config.codebaseMemoryGraphUrl,
      BORON_CODEBASE_MEMORY_COMMAND: config.codebaseMemoryCommand,
      ...launchdDatabaseEnvironment(process.env.BORON_DATABASE_URL)
    }
  })
}

function lanMrLaunchdDefinition(config = loadLanMrConfig()): string {
  const paths = platformPaths('darwin')
  const projectRoot = process.cwd()
  return renderLaunchdPlist({
    label: 'dev.boroncontext.lan-mr',
    nodePath: process.execPath,
    cliPath: resolve(projectRoot, 'dist', 'cli.js'),
    arguments: ['lan-inspector', 'serve'],
    workingDirectory: projectRoot,
    stdoutPath: resolve(paths.logDirectory, 'lan-mr.stdout.log'),
    stderrPath: resolve(paths.logDirectory, 'lan-mr.stderr.log'),
    environment: {
      BORON_LAN_MR_HOST: config.host,
      BORON_LAN_MR_HOSTNAME: config.hostname,
      BORON_LAN_MR_PORT: String(config.httpsPort),
      BORON_LAN_MR_BOOTSTRAP_PORT: String(config.bootstrapPort),
      BORON_LAN_MR_STATE_DIR: config.stateDirectory,
      BORON_LAN_MR_DAEMON_URL: config.daemonUrl,
      BORON_TOKEN_FILE: config.daemonTokenPath,
      BORON_OPENSSL: config.opensslCommand
    }
  })
}

function help(): void {
  console.log(`Boron Context 0.7

Usage:
  boron-context serve          Start the headless local daemon
  boron-context migrate        Apply PostgreSQL migrations
  boron-context health         Read daemon health
  boron-context reconcile-codex-projects --manifest <path> [--state <path>] [--apply]
                               Preview or apply authoritative Codex project identities
  boron-context reconcile-projects --manifest <path> [--state <path>] [--apply]
                               Preview or apply Codex plus operator-approved independent projects
  boron-context repair-project-identities --manifest <path> [--apply]
                               Preview or apply explicit non-destructive identity supersessions
  boron-context print-launchd  Print a macOS launchd plist
  boron-context install-launchd Install and start the macOS background service
  boron-context quest-inspector [--serial <device>] [--stop]
                               Open the authenticated Quest 3 WebXR Inspector through ADB reverse
  boron-context lan-inspector install
                               Install the paired read-only HTTPS LAN MR service
  boron-context lan-inspector pair
                               Print the current one-time Quest pairing code and LAN URLs
`)
}
