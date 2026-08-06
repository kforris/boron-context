import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { platformPaths } from './paths.js'

const portSchema = z.coerce.number().int().min(1).max(65_535)
const privateIpv4Schema = z.ipv4().refine(isPrivateIpv4, {
  message: 'LAN MR host must be a private IPv4 address'
})

export interface LanMrConfig {
  readonly host: string
  readonly hostname: string
  readonly httpsPort: number
  readonly bootstrapPort: number
  readonly stateDirectory: string
  readonly certificateDirectory: string
  readonly daemonUrl: string
  readonly daemonTokenPath: string
  readonly opensslCommand: string
}

export function loadLanMrConfig(env: NodeJS.ProcessEnv = process.env): LanMrConfig {
  const paths = platformPaths(process.platform, env)
  const host = env.BORON_LAN_MR_HOST
    ? privateIpv4Schema.parse(env.BORON_LAN_MR_HOST)
    : detectLanIpv4()
  const httpsPort = portSchema.parse(env.BORON_LAN_MR_PORT ?? '41637')
  const bootstrapPort = portSchema.parse(env.BORON_LAN_MR_BOOTSTRAP_PORT ?? '41636')
  if (httpsPort === bootstrapPort) throw new Error('LAN MR HTTPS and bootstrap ports must differ')
  const stateDirectory = env.BORON_LAN_MR_STATE_DIR ?? join(paths.stateDirectory, 'lan-mr')
  const daemonUrl = new URL(env.BORON_LAN_MR_DAEMON_URL ?? 'http://127.0.0.1:41635')
  if (daemonUrl.protocol !== 'http:' || daemonUrl.hostname !== '127.0.0.1') {
    throw new Error('BORON_LAN_MR_DAEMON_URL must use http://127.0.0.1')
  }
  if (daemonUrl.username || daemonUrl.password) {
    throw new Error('BORON_LAN_MR_DAEMON_URL must not contain credentials')
  }
  return {
    host,
    hostname: normalizeLocalHostname(env.BORON_LAN_MR_HOSTNAME ?? hostname()),
    httpsPort,
    bootstrapPort,
    stateDirectory,
    certificateDirectory: join(stateDirectory, 'certificates'),
    daemonUrl: daemonUrl.toString().replace(/\/$/, ''),
    daemonTokenPath: env.BORON_TOKEN_FILE ?? paths.tokenPath,
    opensslCommand: env.BORON_OPENSSL ?? '/usr/bin/openssl'
  }
}

export function detectLanIpv4(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): string {
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(
        (address) =>
          address.family === 'IPv4' && !address.internal && isPrivateIpv4(address.address)
      )
      .map((address) => ({ name, address: address.address, priority: interfacePriority(name) }))
  )
  if (candidates.length === 0) {
    throw new Error('No private LAN IPv4 address found; set BORON_LAN_MR_HOST explicitly')
  }
  candidates.sort(
    (left, right) => left.priority - right.priority || left.name.localeCompare(right.name)
  )
  const best = candidates[0]!
  const ambiguous = candidates.filter((candidate) => candidate.priority === best.priority)
  if (ambiguous.length > 1) {
    throw new Error(
      `Multiple LAN interfaces are equally preferred (${ambiguous.map((item) => item.address).join(', ')}); set BORON_LAN_MR_HOST explicitly`
    )
  }
  return best.address
}

export function isPrivateIpv4(value: string): boolean {
  const parts = value.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false
  }
  const [first, second] = parts
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

function interfacePriority(name: string): number {
  if (/^(en0|wlan0|eth0)$/i.test(name)) return 0
  if (/^(en|wlan|eth)\d+$/i.test(name)) return 1
  return 10
}

function normalizeLocalHostname(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized) return 'boron.local'
  return normalized.endsWith('.local') ? normalized : `${normalized}.local`
}
