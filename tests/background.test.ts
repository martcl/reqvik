import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProfileDocument } from '../src/model';

function event<T>() {
  const listeners: T[] = [];
  return { listeners, addListener: (listener: T) => listeners.push(listener) };
}

test('navigation keeps badges and titles consistent with automatic activation', async (t) => {
  const doc: ProfileDocument = {
    schemaVersion: 1,
    profiles: [
      {
        id: 'auto',
        name: 'Automatic profile',
        scope: { pageDomains: ['example.test'] },
        autoActivateDomain: 'example.test',
        rules: [
          {
            id: 'header',
            match: { origin: 'https://example.test', pathPrefix: '/' },
            requestHeaders: [{ operation: 'set', name: 'X-Test', value: 'on' }],
          },
        ],
      },
    ],
  };
  const tab = { id: 1, url: 'https://example.test/page' };
  let session: Record<string, unknown> = {};
  let badge = '';
  let title = '';
  let ruleUpdates = 0;
  const onMessage =
    event<
      (
        message: object,
        sender: { id: string; url: string },
        respond: (response: unknown) => void,
      ) => void
    >();
  const onCommitted =
    event<(details: { tabId: number; frameId: number; url: string }) => void>();
  const onUpdated =
    event<
      (id: number, change: { status: string }, current: typeof tab) => void
    >();
  const previous = globalThis.chrome;
  t.after(() => Reflect.set(globalThis, 'chrome', previous));
  Reflect.set(globalThis, 'chrome', {
    storage: {
      local: { get: async () => ({ profileDocument: doc }) },
      session: {
        get: async () => structuredClone(session),
        set: async (value: object) => {
          session = { ...session, ...structuredClone(value) };
        },
      },
    },
    tabs: {
      query: async () => [tab],
      onUpdated,
      onRemoved: event(),
    },
    action: {
      setBadgeText: async (value: { tabId?: number; text: string }) => {
        if (value.tabId === tab.id) badge = value.text;
      },
      setBadgeBackgroundColor: async () => {},
      setTitle: async (value: { title: string }) => {
        title = value.title;
      },
    },
    declarativeNetRequest: {
      isRegexSupported: async () => ({ isSupported: true }),
      getSessionRules: async () => [],
      updateSessionRules: async () => {
        ruleUpdates++;
      },
    },
    permissions: {
      contains: async () => true,
      onAdded: event(),
      onRemoved: event(),
    },
    runtime: {
      id: 'test',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage,
      onInstalled: event(),
      onStartup: event(),
    },
    webNavigation: {
      onBeforeNavigate: event(),
      onCommitted,
      onErrorOccurred: event(),
    },
  });
  await import('../src/background');
  // A message waits for all queued navigation mutations to finish.
  const flush = () =>
    new Promise((resolve) => {
      for (const listener of onMessage.listeners)
        listener(
          { type: 'getState' },
          { id: 'test', url: 'chrome-extension://test/popup.html' },
          resolve,
        );
    });
  await flush();
  assert.equal(badge, 'ON');
  assert.equal(title, 'Reqvik — Automatic profile');
  const initialUpdates = ruleUpdates;

  badge = '';
  title = 'Reqvik — inactive';
  for (const listener of onCommitted.listeners)
    listener({ tabId: tab.id, frameId: 0, url: tab.url });
  await flush();
  assert.equal(badge, 'ON');
  assert.equal(title, 'Reqvik — Automatic profile');
  assert.equal(
    ruleUpdates,
    initialUpdates,
    'Badge refresh keeps installed rules.',
  );

  badge = '';
  for (const listener of onUpdated.listeners)
    listener(tab.id, { status: 'complete' }, tab);
  await flush();
  assert.equal(badge, 'ON');
  assert.equal(ruleUpdates, initialUpdates);

  tab.url = 'https://outside.test/page';
  for (const listener of onCommitted.listeners)
    listener({ tabId: tab.id, frameId: 0, url: tab.url });
  await flush();
  assert.equal(badge, '');
  assert.equal(title, 'Reqvik — inactive');

  badge = 'ON';
  title = 'Reqvik — Automatic profile';
  for (const listener of onUpdated.listeners)
    listener(tab.id, { status: 'complete' }, tab);
  await flush();
  assert.equal(badge, '');
  assert.equal(title, 'Reqvik — inactive');
});
