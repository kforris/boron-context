import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { startCodebaseMemoryGraph } from '../src/platform/codebase-memory-sidecar.js'
import { platformPaths } from '../src/platform/paths.js'
import { normalizeRepositoryUri } from '../src/platform/project-root.js'
import { parseAdbDevices, selectAdbDevice } from '../src/platform/quest-inspector.js'
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

describe('startCodebaseMemoryGraph', () => {
  it('owns only the sidecar it starts and reuses an existing graph endpoint', async () => {
    const url = 'http://127.0.0.1:19749'
    const fixture = fileURLToPath(
      new URL('./fixtures/fake-codebase-memory-sidecar.mjs', import.meta.url)
    )
    const managed = await startCodebaseMemoryGraph({
      command: process.execPath,
      commandArguments: [fixture],
      url
    })
    expect(managed).toMatchObject({ available: true, managed: true })
    const reused = await startCodebaseMemoryGraph({ command: '/not/used', url })
    expect(reused).toMatchObject({ available: true, managed: false })
    await reused.close()
    expect((await fetch(url)).status).toBe(200)
    await managed.close()
    await expect(fetch(url)).rejects.toThrow()
  })
})

describe('loadConfig', () => {
  it('keeps the Inspector graph endpoint on loopback and credential-free', () => {
    expect(
      loadConfig({ BORON_CODEBASE_MEMORY_GRAPH_URL: 'http://localhost:9749' })
        .codebaseMemoryGraphUrl
    ).toBe('http://localhost:9749')
    expect(() =>
      loadConfig({ BORON_CODEBASE_MEMORY_GRAPH_URL: 'https://graph.example.com' })
    ).toThrow(/loopback/)
    expect(() =>
      loadConfig({ BORON_CODEBASE_MEMORY_GRAPH_URL: 'http://user:secret@127.0.0.1:9749' })
    ).toThrow(/credentials/)
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

  it('renders a dedicated command for a separate launchd service', () => {
    const plist = renderLaunchdPlist({
      label: 'dev.boroncontext.lan-mr',
      nodePath: '/usr/bin/node',
      cliPath: '/app/dist/cli.js',
      arguments: ['lan-inspector', 'serve'],
      workingDirectory: '/app',
      stdoutPath: '/logs/lan.out',
      stderrPath: '/logs/lan.err',
      environment: { BORON_LAN_MR_HOST: '192.168.50.23' }
    })
    expect(plist).toContain('<string>lan-inspector</string>')
    expect(plist).toContain('<string>serve</string>')
    expect(plist).not.toContain('<string>serve</string>\n      <string>serve</string>')
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

describe('normalizeRepositoryUri', () => {
  it('maps HTTPS and SSH GitHub remotes to one credential-free identity', () => {
    expect(normalizeRepositoryUri('https://github.com/notionnext-org/NotionNext.git')).toBe(
      'github://notionnext-org/NotionNext'
    )
    expect(normalizeRepositoryUri('git@github.com:notionnext-org/NotionNext.git')).toBe(
      'github://notionnext-org/NotionNext'
    )
    expect(normalizeRepositoryUri('https://token@github.com/owner/repo.git')).toBe(
      'github://owner/repo'
    )
  })
})

describe('Quest Inspector ADB selection', () => {
  it('parses authorized and blocked devices and fails closed on ambiguity', () => {
    const devices = parseAdbDevices(`List of devices attached
1WMHH123456789 device product:panther model:Quest_3 transport_id:1
blocked-device unauthorized usb:1-2 transport_id:2
`)
    expect(devices).toHaveLength(2)
    expect(selectAdbDevice(devices, '1WMHH123456789')).toMatchObject({
      serial: '1WMHH123456789',
      state: 'device'
    })
    expect(() => selectAdbDevice(devices, 'blocked-device')).toThrow(/authorize/)
    expect(() => selectAdbDevice([], undefined)).toThrow(/No Quest found/)
    expect(() =>
      selectAdbDevice(
        [
          { serial: 'one', state: 'device', description: '' },
          { serial: 'two', state: 'device', description: '' }
        ],
        undefined
      )
    ).toThrow(/--serial/)
  })
})
