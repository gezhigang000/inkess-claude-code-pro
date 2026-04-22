#!/usr/bin/env node
// Impersonates the `claude` binary for chat integration tests.
// Emits predetermined stream-json on stdout based on --scenario flag.
//
// Usage (invoked by ChatManager under test):
//   fake-claude.mjs --scenario=happy --session=sess-test-1
//   fake-claude.mjs --scenario=cancel-me
//   fake-claude.mjs --scenario=crash
//   fake-claude.mjs --scenario=hang
//   fake-claude.mjs --scenario=bad-lines

const args = process.argv.slice(2)
const get = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(`--${name}=`.length) : dflt
}
const scenario = get('scenario', 'happy')
const session = get('session', 'sess-fake-1')

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Honour SIGTERM cleanly so cancel tests can observe graceful exit
let cancelled = false
process.on('SIGTERM', () => {
  cancelled = true
  process.exit(143)
})

async function happy() {
  emit({ type: 'system', subtype: 'init', session_id: session, tools: [] })
  await sleep(10)
  emit({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello ' }] },
  })
  await sleep(10)
  emit({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'world.' }] },
  })
  emit({
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 10, output_tokens: 2 },
  })
}

async function cancelMe() {
  emit({ type: 'system', subtype: 'init', session_id: session, tools: [] })
  for (let i = 0; i < 20 && !cancelled; i++) {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: `chunk-${i} ` }] } })
    await sleep(100)
  }
  emit({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } })
}

async function crash() {
  emit({ type: 'system', subtype: 'init', session_id: session, tools: [] })
  await sleep(10)
  process.stderr.write('simulated crash\n')
  process.exit(2)
}

async function hang() {
  emit({ type: 'system', subtype: 'init', session_id: session, tools: [] })
  await new Promise(() => {})
}

async function badLines() {
  emit({ type: 'system', subtype: 'init', session_id: session, tools: [] })
  process.stdout.write('not-json\n')
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'survived' }] } })
  process.stdout.write('{broken\n')
  emit({ type: 'result', subtype: 'success' })
}

const runners = {
  happy,
  'cancel-me': cancelMe,
  crash,
  hang,
  'bad-lines': badLines,
}
const fn = runners[scenario] || happy
fn().catch((err) => {
  process.stderr.write(String(err?.stack || err) + '\n')
  process.exit(1)
})
