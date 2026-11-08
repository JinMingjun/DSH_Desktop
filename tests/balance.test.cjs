// Unit tests for dsh-balance: the browser bundle (loader registration, slot wiring,
// balance rendering) and the host half (credential resolution, upstream mapping).
// No DSH or network required.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const CLIENT = path.join(__dirname, '../plugins/dsh-balance/lib/client.js');
const HOST = path.join(__dirname, '../plugins/dsh-balance/lib/index.js');

let registration;
const loaded = { effects: [] };

function fakeReact() {
  const states = [];
  let cursor = 0;
  return {
    hooks: { reset() { cursor = 0; } },
    React: {
      createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length <= 1 ? children[0] : children } }),
      useRef: init => ({ current: init ?? null }),
      useState: init => {
        const index = cursor++;
        if (!(index in states)) states[index] = init;
        return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
      },
      useLayoutEffect: () => {},
      useEffect: fn => { loaded.effects.push(fn); },
    },
  };
}

function loadClient(fetchImpl) {
  registration = undefined;
  loaded.effects = [];
  const react = fakeReact();
  const sandbox = {
    window: {
      __ModuleLoader__: { load: entry => { registration = entry; } },
      addEventListener() {},
      removeEventListener() {},
      setInterval: () => 0,
      clearInterval() {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      head: { append() {} },
      createElement: () => ({ dataset: {}, remove() {} }),
    },
    fetch: fetchImpl,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox);
  assert.ok(registration, 'bundle must register a loader factory');
  assert.equal(registration.id, 'dsh-balance');
  return { plugin: registration.factory(() => react.React), react };
}

function mount(plugin) {
  const registered = [];
  const ctx = {
    effect(fn) { fn(); },
    slots: {
      inject(name, make) { assert.equal(name, 'conversation.session.header.utilities'); registered.push(make()); },
      register(definition, component) {
        assert.equal(definition.name, 'conversation.session.header.utilities');
        assert.equal(definition.id, 'dsh-balance');
        return component;
      },
    },
  };
  plugin.apply(ctx);
  assert.equal(registered.length, 1, 'apply must register exactly one header component');
  return registered[0];
}

/** Render once more and read the current label after an async refresh settles. */
async function renderAfterRefresh(component, react) {
  loaded.effects = [];
  react.hooks.reset();
  component({});
  const run = loaded.effects[0];
  assert.equal(typeof run, 'function');
  const cleanup = run();
  await new Promise(resolve => setTimeout(resolve, 0));
  react.hooks.reset();
  const element = component({});
  cleanup();
  return element;
}

const okBody = available => ({
  ok: true,
  available,
  wallets: [{ currency: 'CNY', total: '149.64', granted: '4.18', toppedUp: '145.46' }],
});

test('registers the balance entry with only the slots service', () => {
  const { plugin } = loadClient(async () => ({ ok: false, json: async () => ({}) }));
  assert.deepEqual([...plugin.inject], ['slots']);
});

test('renders a placeholder before the balance read resolves', () => {
  const { plugin, react } = loadClient(async () => ({ ok: false, json: async () => ({}) }));
  const component = mount(plugin);
  loaded.effects = [];
  react.hooks.reset();
  const element = component({});
  assert.equal(element.props.className, 'dsh-balance');
  assert.equal(element.props.children, '余额：--');
});

test('renders the total and explains the wallet split from the host route', async () => {
  const { plugin, react } = loadClient(async () => ({ ok: true, json: async () => okBody(true) }));
  const component = mount(plugin);
  const element = await renderAfterRefresh(component, react);
  assert.equal(element.props.children, '余额：149.64 CNY');
  assert.match(element.props.title, /充值 145\.46 CNY/);
  assert.match(element.props.title, /赠送 4\.18 CNY/);
  assert.equal(element.props['aria-label'], undefined);
});

test('surfaces the host error text in the tooltip', async () => {
  const { plugin, react } = loadClient(async () => ({ ok: true, json: async () => ({ ok: false, error: 'API 密钥无效或已过期' }) }));
  const component = mount(plugin);
  const element = await renderAfterRefresh(component, react);
  assert.equal(element.props.children, '余额：--');
  assert.match(element.props.title, /API 密钥无效或已过期/);
  assert.match(element.props['aria-label'], /余额不可用/);
});

test('host route reads the DSH credential store first and maps the upstream payload', async () => {
  const host = await import(pathToFileURL(HOST).href);
  assert.deepEqual([...host.inject], ['connection']);
  let route;
  const ctx = {
    get: name => (name === 'credentials' ? { resolve: async ref => (ref === 'DEEPSEEK_API_KEY' ? { value: '  sk-stored  ', source: 'file' } : undefined) } : undefined),
    connection: { fetch: { register: value => { route = value; return async () => {}; } } },
    effect(fn) { fn(); },
  };
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '149.64', granted_balance: '4.18', topped_up_balance: '145.46' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    host.apply(ctx);
    assert.equal(route.path, '/api/dsh-balance.balance');
    assert.deepEqual([...route.methods], ['GET']);
    const body = await (await route.fetch(new Request('http://127.0.0.1/api/dsh-balance.balance'))).json();
    assert.equal(body.ok, true);
    assert.equal(body.available, true);
    assert.deepEqual(body.wallets, [{ currency: 'CNY', total: '149.64', granted: '4.18', toppedUp: '145.46' }]);
    assert.equal(body.source, 'file');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance');
    assert.equal(calls[0].auth, 'Bearer sk-stored');
    // Bursts share the cached upstream read.
    await route.fetch(new Request('http://127.0.0.1/api/dsh-balance.balance'));
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('host route falls back to DEEPSEEK_API_KEY and reports an invalid key', async () => {
  const host = await import(pathToFileURL(HOST).href);
  let route;
  const ctx = {
    get: () => undefined,
    connection: { fetch: { register: value => { route = value; return async () => {}; } } },
    effect(fn) { fn(); },
  };
  const original = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-env';
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer sk-env');
    return new Response('unauthorized', { status: 401 });
  };
  try {
    host.apply(ctx);
    const body = await (await route.fetch(new Request('http://127.0.0.1/api/dsh-balance.balance'))).json();
    assert.equal(body.ok, false);
    assert.match(body.error, /密钥无效/);
  } finally {
    globalThis.fetch = original;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});
