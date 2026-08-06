#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'

const baseUrl = (process.env.BORON_URL ?? 'http://127.0.0.1:41635').replace(/\/+$/, '')
const clientInstanceId = process.env.CODEX_THREAD_ID ?? randomUUID()
let observedClient = 'unknown'
let observedClientVersion
let observedProtocolVersion

const entitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'name', 'canonicalUri'],
  properties: {
    kind: { type: 'string' },
    name: { type: 'string' },
    canonicalUri: { type: 'string' }
  }
}

const relationEffectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'relationType', 'target', 'operation', 'rationale'],
  properties: {
    subject: entitySchema,
    relationType: { type: 'string' },
    target: entitySchema,
    operation: { type: 'string', enum: ['assert', 'retract'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    confirmationState: { type: 'string', enum: ['candidate', 'confirmed'] },
    rationale: { type: 'string' }
  }
}

const evidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['layer', 'title', 'excerpt'],
  properties: {
    layer: { type: 'string', enum: ['ontology', 'codebase', 'wiki'] },
    title: { type: 'string' },
    uri: { type: 'string' },
    excerpt: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    authority: { type: 'number', minimum: 0, maximum: 1 },
    sourceTokenEstimate: { type: 'integer', minimum: 1 },
    metadata: { type: 'object' }
  }
}

const tools = [
  {
    name: 'boron_health',
    description:
      'Check whether the local Boron Context daemon and PostgreSQL store are available. Does not expose credentials.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'begin_context_session',
    description:
      'Begin a Boron-backed agent session and retrieve the project Context Capsule before substantive work. Call once near the start of a non-trivial project task.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objective'],
      properties: {
        objective: { type: 'string' },
        projectHint: { type: 'string' },
        projectRoot: { type: 'string' },
        externalSessionId: { type: 'string' },
        client: { type: 'string', default: 'codex' },
        constraints: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        tokenBudget: { type: 'integer', minimum: 256, maximum: 16000, default: 4000 },
        leaseMinutes: { type: 'integer', minimum: 15, maximum: 1440, default: 720 },
        metadata: { type: 'object' }
      }
    }
  },
  {
    name: 'query_context',
    description:
      'Read a bounded, sourced Context Capsule without opening a writeback session. Use for questions or when no durable work will be performed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['objective'],
      properties: {
        objective: { type: 'string' },
        projectHint: { type: 'string' },
        objectHints: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        constraints: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        layers: {
          type: 'array',
          items: { type: 'string', enum: ['ontology', 'codebase', 'wiki'] },
          minItems: 1,
          maxItems: 3
        },
        tokenBudget: { type: 'integer', minimum: 256, maximum: 16000, default: 4000 },
        client: { type: 'string', default: 'codex' }
      }
    }
  },
  {
    name: 'record_activity',
    description:
      'Record a bounded semantic activity in an open Boron session. Store decisions, corrections, material actions, tool outcomes, and relation effects—not raw transcripts or every tool call.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId', 'activityType', 'summary'],
      properties: {
        sessionId: { type: 'string', format: 'uuid' },
        activityType: { type: 'string' },
        summary: { type: 'string' },
        actorUri: { type: 'string' },
        targetUri: { type: 'string' },
        occurredAt: { type: 'string', format: 'date-time' },
        idempotencyKey: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        metadata: { type: 'object' },
        relationEffects: { type: 'array', items: relationEffectSchema, maxItems: 50 },
        evidence: { type: 'array', items: evidenceSchema, maxItems: 50 }
      }
    }
  },
  {
    name: 'get_context_meter',
    description:
      'Report auditable Boron context metrics: re-explanation avoided context, source-window coverage and savings only where sourceTokenEstimate exists, candidate filtering, retrieval latency, and Boron-owned LLM usage.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectHint: { type: 'string' },
        windowDays: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
        typingWordsPerMinute: {
          type: 'number',
          minimum: 10,
          maximum: 200,
          default: 40
        }
      }
    }
  },
  {
    name: 'inspect_context_meter',
    description:
      'Read a credential-redacted audit preview of recent Context Meter samples, retrieval plans, adapters, candidate/selected evidence, token estimates, and source coverage. This is read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectHint: { type: 'string' },
        windowDays: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
        typingWordsPerMinute: {
          type: 'number',
          minimum: 10,
          maximum: 200,
          default: 40
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
      }
    }
  },
  {
    name: 'get_adoption_health',
    description:
      'Report observable Boron coverage across hook- or MCP-observed agent threads, session closure, and stale leased sessions. Agents that never load this plugin remain outside the denominator.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        windowDays: { type: 'integer', minimum: 1, maximum: 365, default: 30 }
      }
    }
  },
  {
    name: 'get_codex_sync_health',
    description:
      'Report privacy-safe Codex thread-to-project synchronization health: confirmed, candidate, projectless, conflicted, snapshots, and last sync time. This index does not modify the Codex sidebar or copy prompts/transcripts.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'list_manual_corrections',
    description:
      'List human-authored pending, resolved, or dismissed corrections from Boron Content. At session start, inspect pending corrections for the resolved project and treat them as high-priority review requests, not automatically verified facts.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        projectHint: { type: 'string' },
        layer: { type: 'string', enum: ['ontology', 'codebase', 'wiki'] },
        status: {
          type: 'string',
          enum: ['pending', 'resolved', 'dismissed'],
          default: 'pending'
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 }
      }
    }
  },
  {
    name: 'resolve_manual_correction',
    description:
      'Resolve or dismiss one pending Boron Content correction only after checking current sources and applying or rejecting the semantic repair. Record a concise evidence-backed outcome.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['correctionId', 'outcome', 'summary'],
      properties: {
        correctionId: { type: 'string', format: 'uuid' },
        outcome: { type: 'string', enum: ['resolved', 'dismissed'] },
        summary: { type: 'string' },
        resolvedBy: { type: 'string', default: 'agent' }
      }
    }
  },
  {
    name: 'complete_context_session',
    description:
      'Close a Boron session with its verified outcome, durable decisions, selected evidence, and candidate relation effects. Call after verification and before the final handoff.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId', 'outcome', 'summary'],
      properties: {
        sessionId: { type: 'string', format: 'uuid' },
        outcome: {
          type: 'string',
          enum: ['completed', 'failed', 'partial', 'cancelled']
        },
        summary: { type: 'string' },
        decisions: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        relationEffects: { type: 'array', items: relationEffectSchema, maxItems: 50 },
        evidence: { type: 'array', items: evidenceSchema, maxItems: 50 },
        metadata: { type: 'object' }
      }
    }
  }
]

async function callTool(name, args) {
  switch (name) {
    case 'boron_health':
      return request('/health', { authenticated: false })
    case 'begin_context_session':
      return request('/v1/sessions/start', {
        method: 'POST',
        body: {
          ...args,
          client: args.client ?? 'codex',
          externalSessionId: args.externalSessionId ?? process.env.CODEX_THREAD_ID
        }
      }).then(async (result) => {
        await observe('session_started', result?.session?.id)
        return result
      })
    case 'query_context':
      return request('/v1/context/resolve', {
        method: 'POST',
        body: { ...args, client: args.client ?? 'codex' }
      }).then(async (result) => {
        await observe('context_read')
        return result
      })
    case 'record_activity':
      return request('/v1/activity/record', { method: 'POST', body: args })
    case 'get_context_meter':
      return request('/v1/metrics/context', { method: 'POST', body: args })
    case 'inspect_context_meter':
      return request('/v1/metrics/context/inspect', { method: 'POST', body: args })
    case 'get_adoption_health':
      return request('/v1/metrics/adoption', { method: 'POST', body: args })
    case 'get_codex_sync_health':
      return request('/v1/metrics/codex-sync', { method: 'POST', body: args })
    case 'list_manual_corrections':
      return request('/v1/inspector/corrections/list', { method: 'POST', body: args })
    case 'resolve_manual_correction':
      return request('/v1/inspector/corrections/resolve', { method: 'POST', body: args })
    case 'complete_context_session':
      return request('/v1/sessions/complete', { method: 'POST', body: args }).then(
        async (result) => {
          await observe('session_completed', args.sessionId)
          return result
        }
      )
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

async function request(path, options = {}) {
  const headers = { 'content-type': 'application/json' }
  if (options.authenticated !== false) {
    headers.authorization = `Bearer ${await daemonToken()}`
  }
  let response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    })
  } catch (error) {
    throw new Error(
      `Boron Context is unavailable at ${baseUrl}. Start or repair the local daemon before retrying. ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text }
  }
  if (!response.ok) {
    throw new Error(`Boron Context returned HTTP ${response.status}: ${JSON.stringify(body)}`)
  }
  return body
}

async function daemonToken() {
  if (process.env.BORON_DAEMON_TOKEN) return process.env.BORON_DAEMON_TOKEN
  const path =
    process.env.BORON_TOKEN_FILE ??
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Boron Context', 'daemon.token')
      : join(homedir(), '.local', 'state', 'boron-context', 'daemon.token'))
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    throw new Error(
      `Cannot read the Boron daemon token at ${path}. ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

async function observe(event, sessionId) {
  try {
    await request('/v1/clients/observe', {
      method: 'POST',
      timeoutMs: 500,
      body: {
        clientInstanceId,
        client: observedClient,
        ...(observedClientVersion ? { clientVersion: observedClientVersion } : {}),
        ...(observedProtocolVersion ? { protocolVersion: observedProtocolVersion } : {}),
        event,
        ...(sessionId ? { sessionId } : {}),
        metadata: {
          threadIdentitySource: process.env.CODEX_THREAD_ID ? 'codex_thread_id' : 'process'
        }
      }
    })
  } catch {
    // Observability is fail-open so a temporary Boron outage never prevents MCP initialization.
  }
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

async function handle(message) {
  const { id, method, params = {} } = message
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'initialize') {
    observedClient = params.clientInfo?.name ?? 'unknown'
    observedClientVersion = params.clientInfo?.version
    observedProtocolVersion = params.protocolVersion
    await observe('initialized')
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'boron-context', version: '0.6.0' },
        instructions:
          'Use Boron as a zero-owned-model local context substrate. Read an ontology-first sourced capsule and pending human corrections before project work, record only verified semantic milestones, resolve corrections only after evidence-backed repair, and close the session with verified outcomes. Never store secrets or raw transcripts.'
      }
    })
    return
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } })
    return
  }
  if (method === 'tools/call') {
    try {
      const result = await callTool(params.name, params.arguments ?? {})
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        }
      })
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true
        }
      })
    }
    return
  }
  if (method === 'resources/list') {
    send({ jsonrpc: '2.0', id, result: { resources: [] } })
    return
  }
  if (method === 'prompts/list') {
    send({ jsonrpc: '2.0', id, result: { prompts: [] } })
    return
  }
  if (id !== undefined) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    })
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let queue = Promise.resolve()
input.on('line', (line) => {
  if (!line.trim()) return
  queue = queue
    .then(async () => {
      try {
        await handle(JSON.parse(line))
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
    })
    .catch((error) => {
      process.stderr.write(
        `boron-context internal error: ${error instanceof Error ? error.stack : String(error)}\n`
      )
    })
})
