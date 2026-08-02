import { spawn, type ChildProcess } from 'node:child_process'

const STARTUP_ATTEMPTS = 40
const STARTUP_INTERVAL_MS = 100

export interface RunningCodebaseMemoryGraph {
  readonly available: boolean
  readonly managed: boolean
  readonly detail?: string
  close(): Promise<void>
}

export async function startCodebaseMemoryGraph(input: {
  readonly command: string
  readonly commandArguments?: readonly string[]
  readonly url: string
}): Promise<RunningCodebaseMemoryGraph> {
  if (await reachable(input.url)) return externalGraph()

  const url = new URL(input.url)
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  const child = spawn(
    input.command,
    [...(input.commandArguments ?? []), '--ui=true', `--port=${port}`],
    {
      stdio: ['pipe', 'ignore', 'pipe']
    }
  )
  let startupErrorMessage: string | null = null
  let stderr = ''
  child.once('error', (error) => {
    startupErrorMessage = error.message
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2_000)
  })

  for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt += 1) {
    if (await reachable(input.url)) return managedGraph(child)
    if (startupErrorMessage || child.exitCode !== null) break
    await delay(STARTUP_INTERVAL_MS)
  }

  await terminate(child)
  const detail = startupErrorMessage || stderr.trim() || 'graph endpoint did not become ready'
  return unavailableGraph(detail)
}

function externalGraph(): RunningCodebaseMemoryGraph {
  return { available: true, managed: false, close: async () => {} }
}

function managedGraph(child: ChildProcess): RunningCodebaseMemoryGraph {
  return { available: true, managed: true, close: () => terminate(child) }
}

function unavailableGraph(detail: string): RunningCodebaseMemoryGraph {
  return { available: false, managed: false, detail, close: async () => {} }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) })
    return response.ok
  } catch {
    return false
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.stdin?.end()
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
    delay(2_000).then(() => false)
  ])
  if (!exited && child.exitCode === null) child.kill('SIGKILL')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
