import { execFile } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface LanMrCertificateBundle {
  readonly caCertificatePath: string
  readonly certificatePath: string
  readonly privateKeyPath: string
  readonly caCertificate: Buffer
  readonly caFingerprint256: string
  readonly certificate: Buffer
  readonly privateKey: Buffer
}

interface CertificateMetadata {
  readonly version: 1
  readonly host: string
  readonly hostname: string
}

export async function ensureLanMrCertificates(input: {
  readonly directory: string
  readonly host: string
  readonly hostname: string
  readonly opensslCommand: string
}): Promise<LanMrCertificateBundle> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 })
  await chmod(input.directory, 0o700)
  const caKeyPath = join(input.directory, 'ca-key.pem')
  const caCertificatePath = join(input.directory, 'ca-certificate.pem')
  const certificatePath = join(input.directory, 'server-certificate.pem')
  const privateKeyPath = join(input.directory, 'server-key.pem')
  const metadataPath = join(input.directory, 'server-certificate.json')

  if (!(await readable(caKeyPath)) || !(await readable(caCertificatePath))) {
    await generateCertificateAuthority(input.opensslCommand, caKeyPath, caCertificatePath)
  }

  const expected: CertificateMetadata = {
    version: 1,
    host: input.host,
    hostname: input.hostname
  }
  const current = await readJson<CertificateMetadata>(metadataPath)
  if (
    !current ||
    current.version !== expected.version ||
    current.host !== expected.host ||
    current.hostname !== expected.hostname ||
    !(await readable(certificatePath)) ||
    !(await readable(privateKeyPath))
  ) {
    await generateServerCertificate({
      ...input,
      caKeyPath,
      caCertificatePath,
      certificatePath,
      privateKeyPath
    })
    await writeFile(metadataPath, `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o600 })
  }

  await Promise.all([chmod(caKeyPath, 0o600), chmod(privateKeyPath, 0o600)])
  const caCertificate = await readFile(caCertificatePath)
  return {
    caCertificatePath,
    certificatePath,
    privateKeyPath,
    caCertificate,
    caFingerprint256: new X509Certificate(caCertificate).fingerprint256,
    certificate: await readFile(certificatePath),
    privateKey: await readFile(privateKeyPath)
  }
}

async function generateCertificateAuthority(
  openssl: string,
  keyPath: string,
  certificatePath: string
): Promise<void> {
  const suffix = randomBytes(6).toString('hex')
  const temporaryKey = `${keyPath}.${suffix}.tmp`
  const temporaryCertificate = `${certificatePath}.${suffix}.tmp`
  try {
    await execFileAsync(openssl, ['genrsa', '-out', temporaryKey, '3072'])
    await execFileAsync(openssl, [
      'req',
      '-x509',
      '-new',
      '-key',
      temporaryKey,
      '-sha256',
      '-days',
      '3650',
      '-subj',
      '/CN=Boron LAN MR Local CA',
      '-out',
      temporaryCertificate
    ])
    await chmod(temporaryKey, 0o600)
    await rename(temporaryKey, keyPath)
    await rename(temporaryCertificate, certificatePath)
  } finally {
    await Promise.all([
      rm(temporaryKey, { force: true }),
      rm(temporaryCertificate, { force: true })
    ])
  }
}

async function generateServerCertificate(input: {
  readonly directory: string
  readonly host: string
  readonly hostname: string
  readonly opensslCommand: string
  readonly caKeyPath: string
  readonly caCertificatePath: string
  readonly certificatePath: string
  readonly privateKeyPath: string
}): Promise<void> {
  const suffix = randomBytes(6).toString('hex')
  const temporaryKey = join(input.directory, `server-key.${suffix}.tmp`)
  const requestPath = join(input.directory, `server.${suffix}.csr`)
  const extensionPath = join(input.directory, `server.${suffix}.ext`)
  const temporaryCertificate = join(input.directory, `server-certificate.${suffix}.tmp`)
  const extensions = [
    `subjectAltName=IP:${input.host},DNS:${input.hostname}`,
    'extendedKeyUsage=serverAuth',
    'keyUsage=digitalSignature,keyEncipherment',
    'basicConstraints=CA:FALSE'
  ].join('\n')
  try {
    await writeFile(extensionPath, `${extensions}\n`, { mode: 0o600 })
    await execFileAsync(input.opensslCommand, ['genrsa', '-out', temporaryKey, '2048'])
    await execFileAsync(input.opensslCommand, [
      'req',
      '-new',
      '-key',
      temporaryKey,
      '-subj',
      '/CN=Boron LAN MR',
      '-out',
      requestPath
    ])
    await execFileAsync(input.opensslCommand, [
      'x509',
      '-req',
      '-in',
      requestPath,
      '-CA',
      input.caCertificatePath,
      '-CAkey',
      input.caKeyPath,
      '-set_serial',
      `0x${randomBytes(16).toString('hex')}`,
      '-out',
      temporaryCertificate,
      '-days',
      '397',
      '-sha256',
      '-extfile',
      extensionPath
    ])
    await chmod(temporaryKey, 0o600)
    await rename(temporaryKey, input.privateKeyPath)
    await rename(temporaryCertificate, input.certificatePath)
  } finally {
    await Promise.all(
      [temporaryKey, requestPath, extensionPath, temporaryCertificate].map((path) =>
        rm(path, { force: true })
      )
    )
  }
}

async function readable(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}
