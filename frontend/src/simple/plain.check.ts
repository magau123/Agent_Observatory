// Self-check for plain.ts: `node src/simple/plain.check.ts` (Node 22.18+ runs TypeScript directly).
import assert from 'node:assert/strict'
import type { Agent, AgentEvent, RunSnapshot } from '../types'
import { actionText, buildSteps, fmtSpan, overview, radialLayout } from './plain.ts'

let n = 0
const ev = (event_type: AgentEvent['event_type'], source: string, data: Record<string, unknown> = {}, status: AgentEvent['status'] = null): AgentEvent =>
  ({ event_id: `e${++n}`, timestamp: n * 1000, event_type, platform: 'cursor', run_id: 'r', task_id: null, source, target: null, status, data, duration_ms: null })
const agent = (id: string, kind: Agent['kind'], status: Agent['status'], parent: string | null = null, extra: Partial<Agent> = {}): Agent =>
  ({ id, name: id, kind, parent, status, model: null, task_id: null, current_task: null, current_action: null, started_at: 0, ended_at: null,
    last_active: 0, llm_calls: 0, tool_calls: 0, messages: 0, errors: 0, tokens: null, input: null, output: null, ...extra })

assert.equal(actionText('Read', { file_path: 'E:\\proj\\src\\state.py' }, 'now'), '正在阅读 state.py')
assert.equal(actionText('Shell', '{"command":"npm test","description":"Run tests"}', 'past'), '运行了命令：Run tests')
assert.equal(actionText('WebSearch', { query: 'react flow' }, 'now'), '正在查资料：react flow')
assert.equal(actionText('weird_tool', null, 'past'), '使用了「weird_tool」')
assert.equal(fmtSpan(125_000), '2 分 5 秒')

const run: RunSnapshot = {
  run_id: 'r', platform: 'cursor', title: '重构登录', cwd: null, model: null, status: 'running',
  started_at: 0, updated_at: 0, ended_at: null,
  metrics: {} as RunSnapshot['metrics'],
  agents: [agent('main', 'main', 'waiting', null, { current_action: 'waiting for explore' }),
           agent('s1', 'subagent', 'running', 'main', { name: 'explore', current_task: '查看数据库代码' }),
           agent('w', 'agent', 'idle', null, { name: 'writer' })],
  tasks: [  // an earlier request (t0) and the current one (t1) in the same long-lived session
    { id: 't0', agent: 'main', description: '读需求', status: 'completed', created_at: 0, started_at: 0, ended_at: 5, duration_ms: 5, error: null },
    { id: 't1', agent: 'main', description: '重构登录', status: 'running', created_at: 10, started_at: 10, ended_at: null, duration_ms: null, error: null },
    { id: 't2', agent: 'w', description: '写测试', status: 'created', created_at: 11, started_at: null, ended_at: null, duration_ms: null, error: null },
  ],
}
const events = [
  { ...ev('agent_message', 'user', { content: '重构登录' }), target: 'main' },
  ev('task_start', 'main', { description: '重构登录' }),
  ev('agent_start', 's1', { kind: 'subagent' }),
  { ...ev('agent_message', 'main', { content: 'long prompt for the helper' }), target: 's1' },
  ev('tool_end', 's1', { tool_name: 'Read', input: { file_path: 'a/db.py' } }, 'completed'),
  ev('tool_end', 's1', { tool_name: 'Read', input: { file_path: 'a/models.py' } }, 'completed'),
  ev('tool_end', 's1', { tool_name: 'Read', input: { file_path: 'a/db.py' } }, 'completed'),
  ev('tool_end', 's1', { tool_name: 'Read', input: { file_path: 'a/x.py' }, error: 'File not found' }, 'failed'),
  ev('tool_start', 's1', { tool_name: 'Grep', call_id: 'c9', input: { pattern: 'login' } }),
  { ...ev('agent_message', 's1', { content: { files: 3 } }), target: 'main' },
]
const steps = buildSteps(run, events)
assert.deepEqual(steps.map((s) => `${s.who}|${s.text}`), [
  '主助手|收到任务：重构登录',
  '探索助手|主助手安排探索助手去做：查看数据库代码',
  '探索助手|阅读了 db.py、models.py（共 3 次）',
  '探索助手|阅读了 x.py，但失败了：File not found',
  '探索助手|把结果交给了主助手',  // structured data is not shown to non-programmers
])

const ov = overview(run, events, steps)
assert.equal(ov.title, '重构登录')  // the latest request, not the session's first one
assert.equal(ov.turnStart, 10)
assert.deepEqual(ov.now.map((x) => `${x.who}|${x.what}`), ['主助手|等待助手完成工作', '探索助手|正在查找 login'])
assert.deepEqual(ov.next, ['写测试'])
assert.deepEqual(ov.checklist, [{ label: '写测试', status: 'created' }])  // the earlier request (读需求) is not in this turn's list
assert.equal(ov.errors.length, 1)
assert.deepEqual(ov.progress, { done: 0, total: 1 })  // only steps of the current request count
const lay = radialLayout([{ id: 'm', parent: null }, { id: 'a', parent: 'm' }, { id: 'b', parent: 'm' }, { id: 'a1', parent: 'a' }], 800, 600)
assert.deepEqual(lay.get('m'), { x: 400, y: 300 })  // single root in the centre
assert.ok(lay.get('a')!.x > 400 && lay.get('b')!.x < 400, 'children spread around the root')
const dist = (p: { x: number; y: number }) => Math.hypot(p.x - 400, p.y - 300)
assert.ok(dist(lay.get('a1')!) > dist(lay.get('a')!), 'grandchildren sit on an outer ring')
assert.equal(radialLayout([{ id: 'x', parent: 'x' }], 400, 300).size, 1)  // self-parent must not loop
console.log('plain.ts: all checks passed')
