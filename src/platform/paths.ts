import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface PlatformPaths {
  readonly configDirectory: string
  readonly stateDirectory: string
  readonly logDirectory: string
  readonly tokenPath: string
}

export function platformPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): PlatformPaths {
  const home = resolve(env.HOME ?? homedir())
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support', 'Boron Context')
    return {
      configDirectory: base,
      stateDirectory: base,
      logDirectory: join(home, 'Library', 'Logs', 'Boron Context'),
      tokenPath: env.BORON_TOKEN_FILE ?? join(base, 'daemon.token')
    }
  }
  const config = resolve(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'boron-context')
  const state = resolve(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'boron-context')
  return {
    configDirectory: config,
    stateDirectory: state,
    logDirectory: join(state, 'logs'),
    tokenPath: env.BORON_TOKEN_FILE ?? join(state, 'daemon.token')
  }
}
