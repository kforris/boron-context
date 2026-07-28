#!/usr/bin/env node

import { resolve } from 'node:path'
import { loadConfig } from './config.js'
import { migrateRuntimeDatabase, startRuntime } from './runtime.js'
import { launchdDatabaseEnvironment, renderLaunchdPlist } from './platform/launchd.js'
import { platformPaths } from './platform/paths.js'

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
    case 'print-launchd':
      printLaunchd()
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

function printLaunchd(): void {
  const paths = platformPaths('darwin')
  const projectRoot = process.cwd()
  const config = loadConfig()
  process.stdout.write(
    renderLaunchdPlist({
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
        ...launchdDatabaseEnvironment(process.env.BORON_DATABASE_URL)
      }
    })
  )
}

function help(): void {
  console.log(`Boron Context 0.1

Usage:
  boron-context serve          Start the headless local daemon
  boron-context migrate        Apply PostgreSQL migrations
  boron-context health         Read daemon health
  boron-context print-launchd  Print a macOS launchd plist
`)
}
