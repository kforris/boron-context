import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startLanMrGateway, type RunningLanMrGateway } from './gateway/lan-mr-server.js'
import { LanMrPairingAuthority } from './gateway/lan-mr-auth.js'
import { ensureLanMrCertificates } from './platform/lan-mr-certificates.js'
import { loadLanMrConfig } from './platform/lan-mr-config.js'

export async function startLanMrRuntime(env: NodeJS.ProcessEnv = process.env): Promise<{
  readonly gateway: RunningLanMrGateway
  readonly pairing: LanMrPairingAuthority
  close(): Promise<void>
}> {
  const config = loadLanMrConfig(env)
  const certificates = await ensureLanMrCertificates({
    directory: config.certificateDirectory,
    host: config.host,
    hostname: config.hostname,
    opensslCommand: config.opensslCommand
  })
  const pairing = await LanMrPairingAuthority.create({
    pairingSecretPath: join(config.stateDirectory, 'pairing.secret'),
    sessionSecretPath: join(config.stateDirectory, 'session.secret')
  })
  const daemonToken = (await readFile(config.daemonTokenPath, 'utf8')).trim()
  if (daemonToken.length < 32) throw new Error('Boron daemon token is missing or too short')
  await waitForLanMrDaemon(config.daemonUrl)
  const gateway = await startLanMrGateway({
    host: config.host,
    hostname: config.hostname,
    bootstrapPort: config.bootstrapPort,
    httpsPort: config.httpsPort,
    certificate: certificates.certificate,
    privateKey: certificates.privateKey,
    caCertificate: certificates.caCertificate,
    caFingerprint256: certificates.caFingerprint256,
    daemonUrl: config.daemonUrl,
    daemonToken,
    pairing
  })
  return { gateway, pairing, close: () => gateway.close() }
}

export async function waitForLanMrDaemon(
  daemonUrl: string,
  options: {
    readonly request?: typeof fetch
    readonly attempts?: number
    readonly delayMs?: number
  } = {}
): Promise<void> {
  const request = options.request ?? fetch
  const attempts = options.attempts ?? 30
  const delayMs = options.delayMs ?? 250
  let lastError = 'not attempted'

  // launchd may start the read-only companion before the loopback daemon has bound its port.
  // Retry only this local health dependency; never retry pairing or user requests implicitly.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await request(`${daemonUrl}/health`, {
        signal: AbortSignal.timeout(1_000)
      })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
    }
  }
  throw new Error(`Boron daemon did not become healthy for LAN MR: ${lastError}`)
}
