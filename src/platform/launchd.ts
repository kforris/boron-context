import { escapeXml } from '../util/xml.js'

export interface LaunchdDefinition {
  readonly label: string
  readonly nodePath: string
  readonly cliPath: string
  readonly workingDirectory: string
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly environment: Readonly<Record<string, string>>
  readonly arguments?: readonly string[]
}

export function renderLaunchdPlist(definition: LaunchdDefinition): string {
  const environment = Object.entries(definition.environment)
    .map(
      ([key, value]) =>
        `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(definition.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(definition.nodePath)}</string>
      <string>${escapeXml(definition.cliPath)}</string>
${(definition.arguments ?? ['serve']).map((argument) => `      <string>${escapeXml(argument)}</string>`).join('\n')}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(definition.workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(definition.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(definition.stderrPath)}</string>
  </dict>
</plist>
`
}

export function launchdDatabaseEnvironment(
  databaseUrl: string | undefined
): Readonly<Record<string, string>> {
  if (!databaseUrl) return {}
  const parsed = new URL(databaseUrl)
  if (parsed.password) {
    throw new Error(
      'Refusing to embed a PostgreSQL password in a launchd plist; use a passwordless local role or an OS-protected credential adapter.'
    )
  }
  return { BORON_DATABASE_URL: databaseUrl }
}
