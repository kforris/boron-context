import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { loadConfig } from '../config.js'

const execute = promisify(execFile)

export interface AdbDevice {
  readonly serial: string
  readonly state: string
  readonly description: string
}

export async function openQuestInspector(options: {
  readonly serial?: string
  readonly stop?: boolean
  readonly env?: NodeJS.ProcessEnv
}): Promise<{ readonly serial: string; readonly stopped: boolean }> {
  const env = options.env ?? process.env
  const config = loadConfig(env)
  const adb = env.BORON_ADB ?? 'adb'
  const listing = await execute(adb, ['devices', '-l'])
  const device = selectAdbDevice(parseAdbDevices(listing.stdout), options.serial)
  const remote = `tcp:${config.port}`

  if (options.stop) {
    await execute(adb, ['-s', device.serial, 'reverse', '--remove', remote])
    return { serial: device.serial, stopped: true }
  }

  const token = (env.BORON_DAEMON_TOKEN ?? (await readFile(config.tokenPath, 'utf8'))).trim()
  if (token.length < 32) throw new Error('Boron daemon token is missing or too short')
  const ticketResponse = await fetch(`http://${config.host}:${config.port}/v1/inspector/ticket`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ mode: 'spatial' })
  })
  const ticket = (await ticketResponse.json()) as { url?: unknown; error?: unknown }
  if (!ticketResponse.ok || typeof ticket.url !== 'string') {
    throw new Error(
      typeof ticket.error === 'string'
        ? ticket.error
        : `Boron ticket request returned HTTP ${ticketResponse.status}`
    )
  }

  await execute(adb, ['-s', device.serial, 'reverse', remote, remote])
  const url = `http://127.0.0.1:${config.port}${ticket.url}`
  await execute(adb, [
    '-s',
    device.serial,
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-c',
    'android.intent.category.BROWSABLE',
    '-d',
    url
  ])
  return { serial: device.serial, stopped: false }
}

export function parseAdbDevices(output: string): readonly AdbDevice[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial = '', state = '', ...description] = line.split(/\s+/)
      return { serial, state, description: description.join(' ') }
    })
    .filter((device) => device.serial.length > 0 && device.state.length > 0)
}

export function selectAdbDevice(
  devices: readonly AdbDevice[],
  requestedSerial?: string
): AdbDevice {
  if (requestedSerial) {
    const matched = devices.find((device) => device.serial === requestedSerial)
    if (!matched) throw new Error(`ADB device ${requestedSerial} was not found`)
    if (matched.state !== 'device') {
      throw new Error(`ADB device ${requestedSerial} is ${matched.state}; authorize it in Quest`)
    }
    return matched
  }
  const usable = devices.filter((device) => device.state === 'device')
  if (usable.length === 1) return usable[0]!
  if (usable.length === 0) {
    const blocked = devices[0]
    if (blocked) {
      throw new Error(`No authorized Quest found; ADB device ${blocked.serial} is ${blocked.state}`)
    }
    throw new Error('No Quest found through ADB; connect it once and enable Developer Mode')
  }
  throw new Error('Multiple ADB devices are connected; pass --serial <device>')
}
