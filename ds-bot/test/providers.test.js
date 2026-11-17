import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'
import { install as installModels } from '../src/host/models.js'
import { checkKey, install, keyRefFor, RETRY_POLICY } from '../src/host/providers.js'

// A DSH with the official DeepSeek route, an account route, and the pi-ai adapter: its
// directory offers catalog providers, and its settings take path writes the way DSH's
// do, under a revision. Routes come and go with the pi-ai section.
function dsh({ keys = {}, readOnly = [], user = {}, base = {}, catalog = { anthropic: ['claude-a', 'claude-b'], moonshotai: ['kimi-k3'] } } = {}) {
  const store = { ...keys }
  const writes = []
  const listeners = new Map()
  let revision = 0
  let pi = { user: structuredClone(user), base: structuredClone(base) }
  // DSH merges the layers per provider: a user entry that only sets one field keeps the
  // rest of the provider from the layer below.
  const mergedProviders = (userLayer = pi.user, baseLayer = pi.base) => {
    const providers = structuredClone(baseLayer.providers ?? {})
    for (const [id, profile] of Object.entries(userLayer.providers ?? {})) {
      providers[id] = { ...providers[id], ...structuredClone(profile) }
    }
    return providers
  }
  const piValue = () => ({ providers: mergedProviders() })
  const routes = () => Object.keys(piValue().providers)
  const services = {
    settings: {
      describe: () => [
        { ns: 'llm-deepseek', revision: 0, value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, user: {}, base: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
        { ns: 'llm-deepseek-account', revision: 0, value: {}, user: {}, base: {} },
        { ns: 'llm-pi-ai', revision, value: piValue(), user: structuredClone(pi.user), base: structuredClone(pi.base) },
      ],
      mutate: async (ns, ops, expected) => {
        if (expected !== revision) throw new Error(`settings namespace "${ns}" changed since it was read`)
        const next = structuredClone(pi.user)
        for (const op of ops) {
          const parent = op.path.slice(0, -1).reduce((value, key) => (value[key] ??= {}), next)
          if (op.op === 'set') parent[op.path.at(-1)] = op.value
          else delete parent[op.path.at(-1)]
        }
        const merged = mergedProviders(next)
        for (const id of Object.keys(next.providers ?? {})) {
          if (!(id in catalog) && !((merged[id]?.models?.length ?? 0) > 0)) throw new Error(`llm-pi-ai: provider "${id}" resolves no models`)
        }
        writes.push([ns, ops])
        pi = { ...pi, user: next }
        revision += 1
      },
    },
    credentials: {
      describe: async ref => ({ configured: ref in store, writable: !readOnly.includes(ref) }),
      set: async (ref, value) => { writes.push(['set', ref]); store[ref] = value },
      unset: async (ref) => { writes.push(['unset', ref]); delete store[ref] },
    },
  }
  const discovered = []
  const ctx = {
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    get: name => services[name],
    llm: {
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'deepseek-account', name: 'DeepSeek Account' }, ...routes().map(id => ({ id, name: piValue().providers[id].displayName ?? id }))],
      listModels: async (id) => {
        if (id === 'deepseek-official') return [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }]
        if (id === 'deepseek-account') return []
        const profile = piValue().providers[id]
        return profile.models ?? (catalog[id] ?? []).map(model => ({ id: model }))
      },
      listConfigurableProviders: () => [
        { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
        { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
        ...Object.keys(catalog).map(id => ({ provider: id, displayName: id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id], declared: false })),
        ...routes().filter(id => !(id in catalog)).map(id => ({ provider: id, displayName: piValue().providers[id].displayName ?? id, settingsNs: 'llm-pi-ai', settingsPath: ['providers', id], declared: true })),
      ],
      discoverModels: async (ns, request) => { discovered.push([ns, request]); return [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, inputModalities: ['text'] }, { id: 'relay-2' }] },
    },
  }
  const rt = { ctx, state: { bots: {} } }
  installModels(rt)
  install(rt)
  return { rt, store, writes, listeners, discovered }
}

const needing = async rt => (await rt.catalog({ fresh: true })).filter(entry => entry.needsKey).map(entry => entry.provider)
const row = (view, id) => view.providers.find(provider => provider.id === id)

test('models of a provider whose API key is set nowhere need the key', async () => {
  const user = { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' }, bedrock: {} } }
  const catalog = { moonshotai: ['kimi-k3'], bedrock: ['nova'] }
  assert.deepEqual(await needing(dsh({ user, catalog }).rt), ['deepseek-official', 'moonshotai'])
  assert.deepEqual(await needing(dsh({ user, catalog, keys: { DEEPSEEK_API_KEY: 'k' } }).rt), ['moonshotai'])
  // A route without a key reference authenticates some other way.
  assert.ok((await dsh({ user, catalog }).rt.catalog()).some(entry => entry.provider === 'bedrock' && !entry.needsKey))
})

test('without DSH settings or credentials no model needs a key, and there is no Models page', async () => {
  const { rt } = dsh()
  rt.ctx.get = () => undefined
  assert.deepEqual(await needing(rt), [])
  assert.deepEqual(await rt.providersView(), { available: false })
})

test('the page lists the providers set up and the ones DSH can add', async () => {
  const { rt } = dsh({ keys: { DEEPSEEK_API_KEY: 'k' }, user: { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } } } })
  const view = await rt.providersView()
  assert.deepEqual(view.providers.map(provider => [provider.id, provider.key, provider.removable, provider.models.length]), [
    ['deepseek-official', { configured: true, writable: true }, false, 1],
    ['moonshotai', { configured: false, writable: true }, true, 1],
  ])
  // The account route has no key and no models before a sign-in.
  assert.equal(row(view, 'deepseek-account'), undefined)
  assert.deepEqual(view.addable, [{ id: 'anthropic', name: 'anthropic' }])
  assert.deepEqual(view.protocols, ['openai-completions', 'openai-responses', 'anthropic-messages'])
})

test('a saved API key goes to the provider\'s reference and frees its models', async () => {
  const { rt, store, writes } = dsh()
  await rt.setProviderKey('deepseek-official', '  sk-test  ')
  assert.deepEqual(writes, [['set', 'DEEPSEEK_API_KEY']])
  assert.equal(store.DEEPSEEK_API_KEY, 'sk-test')
  assert.deepEqual(await needing(rt), [])
  await rt.clearProviderKey('deepseek-official')
  assert.equal('DEEPSEEK_API_KEY' in store, false)
  await assert.rejects(rt.setProviderKey('deepseek-account', 'sk-test'), /deepseek-account takes no API key here/)
})

test('a key set outside DS Bot is not overwritten or removed', async () => {
  const { rt, writes } = dsh({ keys: { DEEPSEEK_API_KEY: 'k' }, readOnly: ['DEEPSEEK_API_KEY'] })
  await assert.rejects(rt.setProviderKey('deepseek-official', 'sk-test'), /set outside DS Bot/)
  await assert.rejects(rt.clearProviderKey('deepseek-official'), /set outside DS Bot/)
  assert.deepEqual(writes, [])
  assert.deepEqual(row(await rt.providersView(), 'deepseek-official').key, { configured: true, writable: false })
})

test('a provider from DSH\'s list goes in with the key DSH\'s own page would name', async () => {
  const { rt, store, writes } = dsh()
  const view = await rt.addProvider({ provider: 'moonshotai', key: 'sk-kimi' })
  assert.deepEqual(writes, [['llm-pi-ai', [{ op: 'set', path: ['providers', 'moonshotai'], value: { retryPolicy: RETRY_POLICY, apiKeyEnv: 'MOONSHOTAI_API_KEY' } }]], ['set', 'MOONSHOTAI_API_KEY']])
  assert.equal(store.MOONSHOTAI_API_KEY, 'sk-kimi')
  assert.deepEqual(row(view, 'moonshotai').models.map(model => model.ref), ['moonshotai/kimi-k3'])
  assert.equal(view.addable.some(entry => entry.id === 'moonshotai'), false)
  await assert.rejects(rt.addProvider({ provider: 'moonshotai', key: 'sk-kimi' }), /moonshotai is already set up/)
  await assert.rejects(rt.addProvider({ provider: 'deepseek-official' }), /already set up/)
  await assert.rejects(rt.addProvider({ provider: 'nowhere' }), /DSH offers no provider nowhere/)
})

test('a blank key keeps a key that is already there, else leaves the route without one', async () => {
  const { rt, writes } = dsh({ keys: { ANTHROPIC_API_KEY: 'k' } })
  await rt.addProvider({ provider: 'anthropic', key: '' })
  await rt.addProvider({ provider: 'moonshotai' })
  assert.deepEqual(writes.map(([, ops]) => ops[0].value), [{ retryPolicy: RETRY_POLICY, apiKeyEnv: 'ANTHROPIC_API_KEY' }, { retryPolicy: RETRY_POLICY }])
})

test('a custom API goes in with its endpoint, protocol, compatibility switches and the models picked', async () => {
  const { rt, store, writes } = dsh()
  await rt.addProvider({
    custom: true, provider: 'relay', name: ' My relay ', api: 'openai-completions', baseURL: ' https://relay.example/v1 ', key: 'sk-relay',
    models: [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, inputModalities: ['text'] }, 'relay-2'],
  })
  assert.deepEqual(writes[0], ['llm-pi-ai', [{ op: 'set', path: ['providers', 'relay'], value: {
    displayName: 'My relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', apiKeyEnv: 'RELAY_API_KEY',
    retryPolicy: RETRY_POLICY,
    compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true },
    models: [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, input: ['text'] }, { id: 'relay-2' }],
  } }]])
  assert.equal(store.RELAY_API_KEY, 'sk-relay')
  const view = await rt.providersView()
  assert.deepEqual([row(view, 'relay').name, row(view, 'relay').custom, row(view, 'relay').removable], ['My relay', true, true])
  // OpenAI Responses takes supportsDeveloperRole alone; Anthropic Messages takes no OpenAI compat switch.
  await rt.addProvider({ custom: true, provider: 'resp-gw', api: 'openai-responses', baseURL: 'https://resp.example/v1', models: ['m'] })
  assert.deepEqual(writes.at(-1)[1][0].value.compat, { supportsDeveloperRole: false })
  await rt.addProvider({ custom: true, provider: 'anth-gw', api: 'anthropic-messages', baseURL: 'https://anth.example', models: ['m'] })
  assert.equal(writes.at(-1)[1][0].value.compat, undefined)
})

test('a route DS Bot sets up retries a failed request five times, including the failures pi-ai cannot classify', async () => {
  const { rt, writes } = dsh()
  await rt.addProvider({ provider: 'moonshotai' })
  const value = writes[0][1][0].value
  assert.deepEqual(value.retryPolicy, {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR'],
  })
  // The written profile resolves under the real dsh-llm-pi-ai schema: five retries, and
  // the code an upstream failure pi-ai cannot classify comes back as is retried too.
  const validated = PiAiConfig({ providers: { moonshotai: value } }).providers.get().moonshotai
  assert.equal(validated.retryPolicy.mode, 'normal')
  assert.equal(validated.retryPolicy.maxRetries, 5)
  assert.deepEqual([...validated.retryPolicy.retryableCodes].sort(), ['EMPTY_RESPONSE', 'PI_AI_ERROR', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
})

test('when DSH advertises google-generative-ai in llm-pi-ai schema, Gemini custom routes and discovery are admitted without OpenAI compat switches', async () => {
  const { rt, writes, discovered } = dsh()
  const origDescribe = rt.ctx.get('settings').describe
  // Start from the real Schemastery JSON shape that settings.describe() produces, and
  // ensure google-generative-ai is present in the api union (0.2.2-rc.1 lacks it; rc.2 ships it).
  const realJson = PiAiConfig.toJSON()
  const refs = structuredClone(realJson.refs)
  const apiUnion = Object.values(refs).find(node => node?.type === 'union' && Array.isArray(node.list) && node.list.some(id => refs[String(id)]?.value === 'openai-completions'))
  assert.ok(apiUnion, 'found the api union in real PiAiConfig.toJSON()')
  if (!apiUnion.list.some(id => refs[String(id)]?.value === 'google-generative-ai')) {
    refs.geminiConst = { type: 'const', meta: {}, value: 'google-generative-ai' }
    apiUnion.list.push('geminiConst')
  }
  const geminiSchema = { uid: realJson.uid, refs }
  rt.ctx.get('settings').describe = () => origDescribe().map(section => (section.ns === 'llm-pi-ai' ? { ...section, schema: geminiSchema } : section))
  const view = await rt.providersView()
  assert.deepEqual(view.protocols, ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'])
  await rt.discoverModels({ baseURL: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', key: 'sk-gem' })
  assert.deepEqual(discovered.at(-1), ['llm-pi-ai', { baseURL: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', apiKey: 'sk-gem' }])
  await rt.addProvider({ custom: true, provider: 'gemini-gw', api: 'google-generative-ai', baseURL: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-pro'] })
  assert.equal(writes.at(-1)[1][0].value.api, 'google-generative-ai')
  assert.equal(writes.at(-1)[1][0].value.compat, undefined)
})

test('existing custom routes and custom-endpoint catalog routes backfill missing compatibility switches and the retry policy without overwriting explicit ones', async () => {
  const user = {
    providers: {
      moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' },
      openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://gateway.example/v1', models: [{ id: 'k3.1-pro' }] },
      relay: { api: 'openai-completions', baseURL: 'https://gateway.example/v1', compat: { supportsStore: true }, models: [{ id: 'k3.1-pro' }] },
      kept: { api: 'openai-completions', baseURL: 'https://kept.example/v1', compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true }, retryPolicy: { mode: 'always' }, models: [{ id: 'k3.1-pro' }] },
    },
  }
  const { rt, writes } = dsh({ user, catalog: { moonshotai: ['kimi-k3'], openai: ['gpt-5'], kept: ['k3.1-pro'] } })
  await rt.providersView()
  assert.deepEqual(writes, [['llm-pi-ai', [
    { op: 'set', path: ['providers', 'moonshotai', 'retryPolicy'], value: RETRY_POLICY },
    { op: 'set', path: ['providers', 'openai', 'compat'], value: { supportsDeveloperRole: false } },
    { op: 'set', path: ['providers', 'openai', 'retryPolicy'], value: RETRY_POLICY },
    { op: 'set', path: ['providers', 'relay', 'compat'], value: { supportsDeveloperRole: false, supportsStore: true, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true } },
    { op: 'set', path: ['providers', 'relay', 'retryPolicy'], value: RETRY_POLICY },
  ]]])
  // A second read sees every default in place and writes nothing again.
  writes.length = 0
  await rt.providersView()
  assert.deepEqual(writes, [])
})

test('a custom gateway model whose id matches a built-in catalog model inherits its context window and image support when the endpoint omits them', async () => {
  const { rt, writes } = dsh({ catalog: { 'kimi-coding': ['k3.1-pro'] } })
  const origList = rt.ctx.llm.listConfigurableProviders
  rt.ctx.llm.listConfigurableProviders = () => origList().map(entry => (entry.provider === 'kimi-coding' ? { ...entry, defaultBaseURL: 'https://api.kimi.com/coding/v1' } : entry))
  rt.ctx.llm.discoverModels = async (_ns, request) => {
    if (request.provider === 'kimi-coding') {
      return [{ id: 'k3.1-pro', name: 'Kimi K3.1 Pro', contextWindow: 1048576, maxTokens: 131072, inputModalities: ['text', 'image'] }]
    }
    return [{ id: 'k3.1-pro', name: 'k3.1-pro' }, { id: 'custom-only', name: 'custom-only' }]
  }
  const discovered = await rt.discoverModels({ baseURL: 'https://gateway.example/v1', api: 'openai-completions', key: 'sk-gw' })
  assert.deepEqual(discovered, [
    { id: 'k3.1-pro', name: 'k3.1-pro', contextWindow: 1048576, inputModalities: ['text', 'image'] },
    { id: 'custom-only', name: 'custom-only' },
  ])
  await rt.addProvider({ custom: true, provider: 'my-gateway', api: 'openai-completions', baseURL: 'https://gateway.example/v1', models: ['moonshotai/k3.1-pro'] })
  assert.deepEqual(writes[0][1][0].value.models, [
    { id: 'moonshotai/k3.1-pro', contextWindow: 1048576, input: ['text', 'image'] },
  ])
  // Verify the written profile against the real dsh-llm-pi-ai schema.
  const validated = PiAiConfig({ providers: { 'my-gateway': writes[0][1][0].value } }).providers.get()['my-gateway']
  assert.equal(validated.models[0].id, 'moonshotai/k3.1-pro')
  assert.equal(validated.models[0].contextWindow, 1048576)
  assert.deepEqual(validated.models[0].input, ['text', 'image'])
  assert.equal(validated.compat.supportsDeveloperRole, false)
  assert.equal(validated.compat.supportsStore, false)
  assert.equal(validated.compat.maxTokensField, 'max_tokens')
  assert.equal(validated.compat.requiresReasoningContentOnAssistantMessages, true)
})

test('a custom API is refused before anything is written when it cannot serve', async () => {
  const { rt, writes } = dsh()
  const custom = { custom: true, provider: 'relay', api: 'openai-completions', baseURL: 'https://relay.example/v1', models: ['m'] }
  await assert.rejects(rt.addProvider({ ...custom, provider: 'My Relay' }), /lowercase letters, digits and dashes/)
  await assert.rejects(rt.addProvider({ ...custom, provider: 'anthropic' }), /DSH already offers anthropic/)
  await assert.rejects(rt.addProvider({ ...custom, api: 'grpc' }), /protocol must be one of/)
  await assert.rejects(rt.addProvider({ ...custom, baseURL: 'relay.example' }), /http or https/)
  await assert.rejects(rt.addProvider({ ...custom, baseURL: 'ftp://relay.example' }), /http or https/)
  await assert.rejects(rt.addProvider({ ...custom, models: [] }), /at least one model/)
  await assert.rejects(rt.addProvider({ ...custom, models: ['m', ' m '] }), /same id/)
  await assert.rejects(rt.addProvider({ ...custom, key: 'KEY=sk' }), /NAME=value/)
  assert.deepEqual(writes, [])
})

test('fetching models asks DSH about the endpoint, with the typed key for that question only', async () => {
  const { rt, discovered, store } = dsh()
  const models = await rt.discoverModels({ baseURL: 'https://relay.example/v1', api: 'openai-completions', key: 'sk-relay' })
  assert.deepEqual(discovered, [['llm-pi-ai', { baseURL: 'https://relay.example/v1', api: 'openai-completions', apiKey: 'sk-relay' }]])
  assert.deepEqual(models, [{ id: 'relay-1', name: 'Relay One', contextWindow: 128000, inputModalities: ['text'] }, { id: 'relay-2' }])
  assert.deepEqual(store, {})
  // A provider DSH ships is answered from its own catalog.
  await rt.discoverModels({ provider: 'anthropic' })
  assert.deepEqual(discovered.at(-1), ['llm-pi-ai', { provider: 'anthropic' }])
})

test('removing a provider takes its key along unless another provider names it', async () => {
  const user = { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' }, kimi: { apiKeyEnv: 'MOONSHOTAI_API_KEY', api: 'openai-completions', baseURL: 'https://k.example/v1', models: [{ id: 'k' }] }, relay: { apiKeyEnv: 'RELAY_API_KEY', api: 'openai-completions', baseURL: 'https://r.example/v1', models: [{ id: 'r' }] } } }
  const { rt, store } = dsh({ user, keys: { MOONSHOTAI_API_KEY: 'a', RELAY_API_KEY: 'b' } })
  await rt.removeProvider('moonshotai')
  assert.equal(store.MOONSHOTAI_API_KEY, 'a')
  const view = await rt.removeProvider('relay')
  assert.equal('RELAY_API_KEY' in store, false)
  assert.deepEqual(view.providers.map(provider => provider.id), ['deepseek-official', 'kimi'])
  await assert.rejects(rt.removeProvider('relay'), /relay is not set up/)
  await assert.rejects(rt.removeProvider('deepseek-official'), /not set up/)
})

test('a route that comes with the setup stays', async () => {
  const { rt } = dsh({ base: { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } } } })
  assert.equal(row(await rt.providersView(), 'moonshotai').removable, false)
  await assert.rejects(rt.removeProvider('moonshotai'), /comes with this setup/)
})

test('a changed credential drops the cached catalog', async () => {
  const { rt, store, listeners } = dsh()
  assert.deepEqual(await needing(rt), ['deepseek-official'])
  store.DEEPSEEK_API_KEY = 'k'
  assert.deepEqual((await rt.catalog()).filter(entry => entry.needsKey).map(entry => entry.provider), ['deepseek-official'])
  listeners.get('credentials/reference-updated')()
  assert.deepEqual((await rt.catalog()).filter(entry => entry.needsKey).map(entry => entry.provider), [])
})

test('an API key is what an HTTP header carries, without a NAME= or quotes', () => {
  assert.equal(checkKey(' sk-abc '), 'sk-abc')
  assert.equal(checkKey('YWJj=='), 'YWJj==')
  assert.throws(() => checkKey('   '), /Enter the API key/)
  assert.throws(() => checkKey(undefined), /Enter the API key/)
  assert.throws(() => checkKey('DEEPSEEK_API_KEY=sk-abc'), /not a NAME=value line/)
  assert.throws(() => checkKey('"sk-abc"'), /without quotes/)
  assert.throws(() => checkKey('sk abc'), /no spaces/)
  assert.throws(() => checkKey('sk-密钥'), /no spaces/)
})

test('a route\'s key reference follows DSH\'s own Models page', () => {
  assert.equal(keyRefFor('moonshotai'), 'MOONSHOTAI_API_KEY')
  assert.equal(keyRefFor('my-gateway2'), 'MY_GATEWAY2_API_KEY')
})

test('the page sets how many times a failed request is retried', async () => {
  const user = { providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } } }
  const { rt, writes } = dsh({ user, catalog: { moonshotai: ['kimi-k3'] } })
  // A route with no policy of its own runs on the default five.
  assert.deepEqual(row(await rt.providersView(), 'moonshotai').retry, { mode: 'normal', maxRetries: 5 })
  const view = await rt.setProviderRetry('moonshotai', 3)
  assert.deepEqual(writes.at(-1), ['llm-pi-ai', [{
    op: 'set',
    path: ['providers', 'moonshotai', 'retryPolicy'],
    value: { mode: 'normal', maxRetries: 3, retryableCodes: [...RETRY_POLICY.retryableCodes] },
  }]])
  assert.deepEqual(row(view, 'moonshotai').retry, { mode: 'normal', maxRetries: 3 })
  // 0 turns retrying off; the page offers 0 to 10 only.
  assert.deepEqual(row(await rt.setProviderRetry('moonshotai', 0), 'moonshotai').retry, { mode: 'normal', maxRetries: 0 })
  for (const bad of [11, -1, 1.5, Number.NaN]) await assert.rejects(rt.setProviderRetry('moonshotai', bad), /whole number from 0 to 10/)
  await assert.rejects(rt.setProviderRetry('nope', 2), /not set up/)
  await assert.rejects(rt.setProviderRetry('deepseek-official', 2), /not set up/)
})

test('a provider that comes with the setup takes a retry count and keeps its key and models', async () => {
  const base = { providers: { timi: { displayName: 'Timi', apiKeyEnv: 'TIMI_API_KEY', models: [{ id: 'm1' }] } } }
  const { rt } = dsh({ base, keys: { TIMI_API_KEY: 'k' } })
  const view = await rt.setProviderRetry('timi', 0)
  const timi = row(view, 'timi')
  assert.deepEqual(timi.retry, { mode: 'normal', maxRetries: 0 })
  assert.equal(timi.removable, false)
  assert.deepEqual(timi.key, { configured: true, writable: true })
  assert.deepEqual(timi.models.map(model => model.name), ['m1'])
})

test('saving a count keeps the codes and backoff a route was given by hand', async () => {
  const user = { providers: { relay: {
    api: 'openai-completions',
    baseURL: 'https://r.example/v1',
    models: [{ id: 'r' }],
    retryPolicy: { mode: 'always', retryableCodes: ['RATE_LIMIT'], backoff: { initialDelayMs: 100 } },
  } } }
  const { rt, writes } = dsh({ user })
  // A policy set by hand to always retry has no count to show.
  assert.deepEqual(row(await rt.providersView(), 'relay').retry, { mode: 'always', maxRetries: null })
  await rt.setProviderRetry('relay', 4)
  assert.deepEqual(writes.at(-1)[1][0].value, {
    mode: 'normal',
    maxRetries: 4,
    retryableCodes: ['RATE_LIMIT'],
    backoff: { initialDelayMs: 100 },
  })
})
