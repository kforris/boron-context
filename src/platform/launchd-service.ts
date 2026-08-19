import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface LaunchdInstallResult {
  readonly label: string
  readonly plistPath: string
  readonly serviceTarget: string
}

export function validateLaunchdLabel(label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(label) || label.includes('..')) {
    throw new Error(`Invalid launchd label: ${label}`)
  }
  return label
}

export async function installLaunchdService(input: {
  readonly label: string
  readonly plist: string
  readonly logDirectory: string
}): Promise<LaunchdInstallResult> {
  const label = validateLaunchdLabel(input.label)
  if (process.platform !== 'darwin') {
    throw new Error('launchd installation is only available on macOS')
  }
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Cannot determine the current macOS user ID')
  const launchAgents = join(homedir(), 'Library', 'LaunchAgents')
  const plistPath = join(launchAgents, `${label}.plist`)
  const serviceTarget = `gui/${uid}/${label}`
  await mkdir(launchAgents, { recursive: true })
  await mkdir(input.logDirectory, { recursive: true })
  await writeFile(plistPath, input.plist, { encoding: 'utf8', mode: 0o600 })

  try {
    await execFileAsync('/bin/launchctl', ['bootout', `gui/${uid}`, plistPath])
  } catch {
    // A first-time install has nothing to unload.
  }
  await execFileAsync('/bin/launchctl', ['bootstrap', `gui/${uid}`, plistPath])
  await execFileAsync('/bin/launchctl', ['kickstart', '-k', serviceTarget])
  return { label, plistPath, serviceTarget }
}
