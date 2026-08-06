import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const PAIRING_WINDOW_MS = 5 * 60 * 1_000
const SESSION_TTL_MS = 8 * 60 * 60 * 1_000

export class LanMrPairingAuthority {
  private exchanging = false

  private constructor(
    private pairingSecret: Buffer,
    private readonly sessionSecret: Buffer,
    private readonly pairingSecretPath: string,
    private readonly clock: () => number
  ) {}

  static async create(input: {
    readonly pairingSecretPath: string
    readonly sessionSecretPath: string
    readonly clock?: () => number
  }): Promise<LanMrPairingAuthority> {
    return new LanMrPairingAuthority(
      await loadOrCreateSecret(input.pairingSecretPath),
      await loadOrCreateSecret(input.sessionSecretPath),
      input.pairingSecretPath,
      input.clock ?? Date.now
    )
  }

  currentPairing(): { readonly code: string; readonly expiresAt: string } {
    const now = this.clock()
    const window = Math.floor(now / PAIRING_WINDOW_MS)
    return {
      code: pairingCode(this.pairingSecret, window),
      expiresAt: new Date((window + 1) * PAIRING_WINDOW_MS).toISOString()
    }
  }

  async exchange(code: string, clientAddress: string): Promise<string | undefined> {
    if (this.exchanging || !/^\d{6}$/.test(code)) return undefined
    const expected = this.currentPairing().code
    if (!safeTextEqual(code, expected)) return undefined
    this.exchanging = true
    try {
      const replacement = randomBytes(32)
      await replaceSecret(this.pairingSecretPath, replacement)
      this.pairingSecret = replacement
      return this.issueSession(clientAddress)
    } finally {
      this.exchanging = false
    }
  }

  verifySession(token: string | undefined, clientAddress: string): boolean {
    if (!token) return false
    const [encoded, suppliedSignature, extra] = token.split('.')
    if (!encoded || !suppliedSignature || extra) return false
    const expectedSignature = signature(this.sessionSecret, encoded)
    if (!safeTextEqual(suppliedSignature, expectedSignature)) return false
    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
        v?: unknown
        exp?: unknown
        client?: unknown
      }
      return (
        payload.v === 1 &&
        typeof payload.exp === 'number' &&
        payload.exp > this.clock() &&
        payload.client === clientAddress
      )
    } catch {
      return false
    }
  }

  private issueSession(clientAddress: string): string {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        exp: this.clock() + SESSION_TTL_MS,
        client: clientAddress,
        nonce: randomBytes(12).toString('base64url')
      })
    ).toString('base64url')
    return `${payload}.${signature(this.sessionSecret, payload)}`
  }
}

export const lanMrSessionTtlSeconds = SESSION_TTL_MS / 1_000

function pairingCode(secret: Buffer, window: number): string {
  const digest = createHmac('sha256', secret).update(`pair:${window}`).digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

function signature(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

async function loadOrCreateSecret(path: string): Promise<Buffer> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const handle = await open(path, 'wx', 0o600)
    const secret = randomBytes(32)
    try {
      await handle.writeFile(secret)
    } finally {
      await handle.close()
    }
    return secret
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const secret = await readFile(path)
  if (secret.length !== 32) throw new Error(`Invalid Boron LAN MR secret at ${path}`)
  await chmod(path, 0o600)
  return secret
}

async function replaceSecret(path: string, secret: Buffer): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, secret, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
