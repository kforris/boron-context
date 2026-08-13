import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  collectCodexThreadSyncBatches,
  handleHook,
  renderAdditionalContext
} from '../plugins/boron-context/hooks/boron-context-hook.mjs'

describe('Codex lifecycle hook', () => {
  it('bootstraps bounded project context without reading prompt or transcript content', async () => {
    const calls = []
    const request = async (path, body) => {
      calls.push({ path, body })
      if (path === '/v1/sessions/bootstrap') {
        return {
          started: true,
          session: {
            id: 'f40560bc-4ec7-4bbb-9898-61df26cf55a7',
            project: { name: 'Boron Context', confidence: 0.99 }
          },
          capsule: {
            evidence: [
              {
                layer: 'ontology',
                title: 'Verified project state',
                excerpt: 'The current release passed its checks.',
                uri: 'boron://evidence/verified-state',
                retrieval: { sourceType: 'ontology' }
              }
            ],
            unresolved: []
          }
        }
      }
      return { observed: true }
    }

    const output = await handleHook(
      {
        hook_event_name: 'SessionStart',
        session_id: 'thread-hook-test',
        cwd: '/workspace/boron-context',
        source: 'startup',
        transcript_path: '/private/transcript-that-must-not-be-read.jsonl',
        prompt: 'raw prompt that must not be sent'
      },
      { request, collectThreadSync: async () => [] }
    )

    expect(calls.map((call) => call.path)).toEqual([
      '/v1/clients/observe',
      '/v1/sessions/bootstrap',
      '/v1/clients/observe'
    ])
    expect(JSON.stringify(calls)).not.toContain('raw prompt')
    expect(JSON.stringify(calls)).not.toContain('transcript-that-must-not-be-read')
    expect(calls[1].body).toMatchObject({
      projectRoot: '/workspace/boron-context',
      externalSessionId: 'thread-hook-test',
      client: 'codex'
    })
    expect(calls[0].body).toMatchObject({ integration: 'codex_hook' })
    expect(calls[2].body).toMatchObject({ integration: 'codex_hook' })
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Boron automatic project context is loaded'
    )
    expect(output.hookSpecificOutput.additionalContext).toContain('Verified project state')
  })

  it('ends an active lifecycle session without forwarding the transcript', async () => {
    const calls = []
    const request = async (path, body) => {
      calls.push({ path, body })
      if (path === '/v1/sessions/lifecycle-end') {
        return {
          closed: true,
          sessionId: 'f40560bc-4ec7-4bbb-9898-61df26cf55a7',
          status: 'partial',
          reason: 'client_session_end'
        }
      }
      return { observed: true }
    }

    expect(
      await handleHook(
        {
          hook_event_name: 'SessionEnd',
          session_id: 'thread-hook-test',
          cwd: '/workspace/boron-context',
          reason: 'other',
          transcript_path: '/private/session-end-transcript.jsonl'
        },
        { request }
      )
    ).toBeNull()
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/sessions/lifecycle-end',
      '/v1/clients/observe'
    ])
    expect(calls[1].body).toMatchObject({ integration: 'codex_hook' })
    expect(JSON.stringify(calls)).not.toContain('session-end-transcript')
  })

  it('fails open and caps model-visible context', async () => {
    expect(
      await handleHook(
        {
          hook_event_name: 'SessionStart',
          session_id: 'unavailable-daemon',
          cwd: '/workspace/project',
          source: 'startup'
        },
        {
          request: async () => Promise.reject(new Error('offline')),
          collectThreadSync: async () => []
        }
      )
    ).toBeNull()

    const context = renderAdditionalContext({
      session: {
        id: 'f40560bc-4ec7-4bbb-9898-61df26cf55a7',
        project: { name: 'Bounded project', confidence: 1 }
      },
      capsule: {
        evidence: Array.from({ length: 20 }, (_, index) => ({
          layer: 'wiki',
          title: `Evidence ${index}`,
          excerpt: 'x'.repeat(2_000),
          uri: `boron://evidence/${index}`,
          retrieval: { sourceType: 'snapshot' }
        })),
        unresolved: Array.from({ length: 20 }, () => 'y'.repeat(2_000))
      }
    })
    expect(context.length).toBeLessThanOrEqual(7_500)
    expect(context).toContain('Evidence 5')
    expect(context).not.toContain('Evidence 6')
  })

  it('syncs only privacy-safe reviewed thread ownership at startup', async () => {
    const policy = Buffer.from(JSON.stringify({ authority: 'user_approved' }))
    const policyHash = createHash('sha256').update(policy).digest('hex')
    const files = new Map([
      [
        '/test/.codex/.codex-global-state.json',
        Buffer.from(
          JSON.stringify({
            'thread-project-assignments': {
              'thread-existing': { projectId: 'project-a', title: 'must never be read' }
            }
          })
        )
      ],
      [
        '/test/.codex/boron-context/thread-project-plan.json',
        Buffer.from(
          JSON.stringify({
            source: { policyPath: '/test/policy.json', policySha256: policyHash },
            confirmed: [
              { threadId: 'thread-reviewed', targetProjectId: 'project-b', titleDigest: 'safe' }
            ],
            intentionallyProjectless: [{ threadId: 'thread-greeting', reason: 'reviewed' }]
          })
        )
      ],
      ['/test/policy.json', policy]
    ])
    const batches = await collectCodexThreadSyncBatches({
      home: '/test',
      readFile: async (path) => {
        const value = files.get(path)
        if (!value) throw new Error(`missing ${path}`)
        return value
      }
    })

    expect(batches).toHaveLength(1)
    expect(batches[0].observations).toHaveLength(3)
    expect(batches[0].observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalThreadId: 'thread-existing',
          codexProjectId: 'project-a',
          authority: 'codex_project_assignment'
        }),
        expect.objectContaining({
          externalThreadId: 'thread-reviewed',
          codexProjectId: 'project-b',
          authority: 'user_approved_plan'
        }),
        expect.objectContaining({
          externalThreadId: 'thread-greeting',
          classificationState: 'projectless',
          authority: 'user_approved_plan'
        })
      ])
    )
    expect(JSON.stringify(batches)).not.toContain('must never be read')
    expect(batches[0].metadata).toMatchObject({ privacyBoundary: 'no_prompt_or_transcript' })
  })
})
