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
  const daemonHealth = await fetch(`${config.daemonUrl}/health`, {
    signal: AbortSignal.timeout(3_000)
  })
  if (!daemonHealth.ok) throw new Error(`Boron daemon health returned HTTP ${daemonHealth.status}`)
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
