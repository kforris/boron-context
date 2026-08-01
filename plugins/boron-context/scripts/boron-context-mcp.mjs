#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'

const baseUrl = (process.env.BORON_URL ?? 'http://127.0.0.1:41635').replace(/\/+$/, '')

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
        body: { ...args, client: args.client ?? 'codex' }
      })
    case 'query_context':
      return request('/v1/context/resolve', {
        method: 'POST',
        body: { ...args, client: args.client ?? 'codex' }
      })
    case 'record_activity':
      return request('/v1/activity/record', { method: 'POST', body: args })
    case 'get_context_meter':
      return request('/v1/metrics/context', { method: 'POST', body: args })
    case 'inspect_context_meter':
      return request('/v1/metrics/context/inspect', { method: 'POST', body: args })
    case 'complete_context_session':
      return request('/v1/sessions/complete', { method: 'POST', body: args })
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

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

async function handle(message) {
  const { id, method, params = {} } = message
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'boron-context', version: '0.3.0' },
        instructions:
          'Use Boron as a zero-owned-model local context substrate. Read an ontology-first sourced capsule before project work, record only verified semantic milestones, and close the session with verified outcomes. Never store secrets or raw transcripts.'
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
