import { describe, expect, it } from 'vitest'
import { platformPaths } from '../src/platform/paths.js'
import { launchdDatabaseEnvironment, renderLaunchdPlist } from '../src/platform/launchd.js'

describe('platformPaths', () => {
  it('uses macOS application support paths', () => {
    const paths = platformPaths('darwin', { HOME: '/Users/test' })
    expect(paths.tokenPath).toBe(
      '/Users/test/Library/Application Support/Boron Context/daemon.token'
    )
  })

  it('uses XDG paths on Linux', () => {
    const paths = platformPaths('linux', {
      HOME: '/home/test',
      XDG_STATE_HOME: '/state',
      XDG_CONFIG_HOME: '/config'
    })
    expect(paths.stateDirectory).toBe('/state/boron-context')
    expect(paths.configDirectory).toBe('/config/boron-context')
  })
})

describe('renderLaunchdPlist', () => {
  it('escapes paths and environment values', () => {
    const plist = renderLaunchdPlist({
      label: 'dev.boroncontext.daemon',
      nodePath: '/path/with &/node',
      cliPath: '/app/dist/cli.js',
      workingDirectory: '/app',
      stdoutPath: '/logs/out.log',
      stderrPath: '/logs/error.log',
      environment: { BORON_DATABASE_URL: 'postgres://user:<secret>@localhost/db' }
    })
    expect(plist).toContain('/path/with &amp;/node')
    expect(plist).toContain('postgres://user:&lt;secret&gt;@localhost/db')
  })

  it('refuses to print database passwords into a public plist file', () => {
    expect(() =>
      launchdDatabaseEnvironment('postgresql://user:secret@127.0.0.1/boron_context')
    ).toThrow(/password/)
    expect(launchdDatabaseEnvironment('postgresql://127.0.0.1/boron_context')).toEqual({
      BORON_DATABASE_URL: 'postgresql://127.0.0.1/boron_context'
    })
  })
})
