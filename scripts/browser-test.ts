import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright';

type Observation = {
  host: string;
  url: string;
  method: string;
  body: string;
  headers: IncomingMessage['headers'];
};
async function server() {
  const observations: Observation[] = [];
  const instance = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const observation = {
      host: request.headers.host ?? '',
      url: request.url ?? '',
      method: request.method ?? '',
      body,
      headers: request.headers,
    };
    observations.push(observation);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url?.startsWith('/redirect?')) {
      response.statusCode = 302;
      response.setHeader(
        'Location',
        new URL(request.url, 'http://localhost').searchParams.get('to')!,
      );
      response.end();
    } else if (request.url?.startsWith('/page')) {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<!doctype html><title>Request fixture</title><h1>Request fixture</h1>',
      );
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(observation));
    }
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  const address = instance.address();
  assert.ok(address && typeof address !== 'string');
  return {
    port: address.port,
    observations,
    close: () =>
      new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
const source = await server(),
  target = await server();
const directory = await mkdtemp(join(tmpdir(), 'reqvik-browser-'));
const extension = join(directory, 'extension');
await cp(resolve('dist'), extension, { recursive: true });
const manifest = JSON.parse(
  await readFile(join(extension, 'manifest.json'), 'utf8'),
);
assert.equal(
  manifest.host_permissions,
  undefined,
  'Production must request host access on activation.',
);
// Only the isolated test copy pre-grants fixture origins; production stays optional.
manifest.host_permissions = ['http://*.localhost/*', 'https://*.localhost/*'];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
const sourceOrigin = `http://source.preview.localhost:${source.port}`,
  targetOrigin = `http://target.preview.localhost:${target.port}`;
let context:
  | Awaited<ReturnType<typeof chromium.launchPersistentContext>>
  | undefined;
try {
  context = await chromium.launchPersistentContext(join(directory, 'browser'), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-proxy-server',
      '--host-resolver-rules=MAP *.localhost 127.0.0.1',
    ],
  });
  const errors: string[] = [];
  context.on('page', (page) =>
    page.on('pageerror', (error) => errors.push(error.message)),
  );
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.getByRole('button', { name: 'New profile' }).click();
  await options
    .getByLabel('Profile name', { exact: true })
    .fill('Browser test');
  await options
    .getByLabel('Allowed page domains')
    .fill('https://*.preview.localhost');
  await options
    .getByLabel('Request origin', { exact: true })
    .fill(sourceOrigin);
  await options.getByText('Advanced options', { exact: true }).click();
  await options.getByLabel('Host override').fill(targetOrigin);
  await options.getByRole('button', { name: 'Add header' }).click();
  await options.getByLabel('Header name', { exact: true }).fill('X-Reqvik');
  await options.getByLabel('Value', { exact: true }).fill('active');
  await options.getByRole('button', { name: 'Add header' }).click();
  await options
    .getByLabel('Header name', { exact: true })
    .nth(1)
    .fill('X-Remove');
  await options.getByLabel('Operation').nth(1).selectOption('remove');
  await options
    .getByRole('button', { name: 'Save profile', exact: true })
    .first()
    .click();
  await options.locator('[role="status"], [role="alert"]').waitFor();
  assert.equal(
    await options.getByRole('alert').count(),
    0,
    (await options.getByRole('alert').allTextContents()).join('\n'),
  );
  await options.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
  const rpc = async <T>(message: object): Promise<T> =>
    options.evaluate(async (message) => {
      const result = await chrome.runtime.sendMessage(message);
      if (!result.ok) throw new Error(result.error);
      return result;
    }, message);
  const state = await rpc<{
    doc: import('../src/model').ProfileDocument;
    activations: unknown[];
  }>({ type: 'getState' });
  assert.equal(state.activations.length, 0, 'Saving must not activate.');
  const profile = state.doc.profiles[0];
  assert.ok(profile);
  assert.deepEqual(profile.scope.pageDomains, ['*.preview.localhost']);
  assert.equal(
    await options
      .getByRole('button', { name: 'Use Example local example' })
      .count(),
    0,
  );
  assert.equal(
    await options.getByRole('heading', { name: 'Check a request' }).count(),
    0,
  );
  const unrelated = structuredClone(profile);
  unrelated.id = 'unrelated';
  unrelated.name = 'Unrelated profile';
  unrelated.scope.pageDomains = ['unrelated.example'];
  unrelated.rules[0].match.origin = 'https://unrelated.example';
  delete unrelated.rules[0].redirectOrigin;
  await rpc({
    type: 'saveDocument',
    doc: { schemaVersion: 1, profiles: [profile, unrelated] },
  });
  await options
    .getByRole('button', { name: 'Unrelated profile', exact: false })
    .waitFor();
  // Storage refreshes must preserve both draft edits and partially typed domain text.
  await options
    .getByLabel('Profile name', { exact: true })
    .fill('Unsaved draft');
  const rawDomains = '*.preview.localhost,\n';
  await options.getByLabel('Allowed page domains').fill(rawDomains);
  await rpc({
    type: 'saveDocument',
    doc: {
      schemaVersion: 1,
      profiles: [profile, { ...unrelated, name: 'External update' }],
    },
  });
  await options
    .getByRole('button', { name: 'External update', exact: false })
    .waitFor();
  assert.equal(
    await options.getByLabel('Profile name', { exact: true }).inputValue(),
    'Unsaved draft',
  );
  assert.equal(
    await options.getByLabel('Allowed page domains').inputValue(),
    rawDomains,
  );
  options.once('dialog', (dialog) => {
    void dialog.accept();
  });
  await options
    .locator('nav')
    .getByRole('button', { name: profile.name, exact: false })
    .click();
  assert.equal(
    await options.getByLabel('Profile name', { exact: true }).inputValue(),
    profile.name,
  );
  // A clean editor follows saved changes to the selected profile.
  await rpc({
    type: 'saveDocument',
    doc: {
      schemaVersion: 1,
      profiles: [{ ...profile, name: 'Updated saved profile' }, unrelated],
    },
  });
  await options.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>('input[maxlength="100"]')
        ?.value === 'Updated saved profile',
  );
  await rpc({
    type: 'saveDocument',
    doc: { schemaVersion: 1, profiles: [profile, unrelated] },
  });
  await options.waitForFunction(
    (name) =>
      document.querySelector<HTMLInputElement>('input[maxlength="100"]')
        ?.value === name,
    profile.name,
  );
  console.log(
    'PASS: storage refresh preserves unsaved edits and refreshes clean drafts.',
  );
  const tab = await context.newPage();
  await tab.goto(`${sourceOrigin}/page`);
  const tabId = await options.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    `${sourceOrigin}/page`,
  );
  const activate = () =>
    rpc({ type: 'activate', profileId: profile.id, tabId });
  const get = async (page: Page, url: string, method = 'GET') =>
    page.evaluate(
      async ({ url, method }) => {
        const response = await fetch(url, {
          method,
          headers: { 'X-Remove': 'remove-me' },
          ...(method === 'POST' ? { body: 'preserved-body' } : {}),
        });
        return response.json();
      },
      { url, method },
    ) as Promise<Observation>;
  const popup = await context.newPage();
  await options.evaluate(
    async (id) => chrome.tabs.update(id, { active: true }),
    tabId,
  );
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('combobox').waitFor();
  assert.equal(await popup.locator('select option').count(), 1);
  assert.equal(await popup.locator('select option').innerText(), profile.name);
  await popup.getByRole('button', { name: 'Activate in this tab' }).click();
  await popup
    .getByRole('status')
    .filter({ hasText: 'Active in this tab.' })
    .waitFor();
  await popup.screenshot({ path: join(directory, 'popup.png') });
  await popup.close();
  await tab.goto(`${sourceOrigin}/echo?query=preserved`);
  assert.equal(tab.url(), `${targetOrigin}/echo?query=preserved`);
  const navigation = JSON.parse(await tab.locator('body').innerText());
  assert.equal(navigation.headers['x-reqvik'], 'active');
  assert.equal(navigation.host, `target.preview.localhost:${target.port}`);
  console.log(
    'PASS: React editor saves versioned JSON; navigation redirects with headers and query intact.',
  );
  await tab.goto(`${targetOrigin}/page`);
  const redirected = await get(
    tab,
    `${sourceOrigin}/echo?subresource=1`,
    'POST',
  );
  assert.equal(redirected.host, `target.preview.localhost:${target.port}`);
  assert.equal(redirected.headers['x-reqvik'], 'active');
  assert.equal(redirected.headers['x-remove'], undefined);
  assert.equal(redirected.method, 'POST');
  assert.equal(redirected.body, 'preserved-body');
  console.log(
    'PASS: subresource redirects preserve POST body; headers set and removed at destination.',
  );
  const chained = await get(
    tab,
    `${targetOrigin}/redirect?to=${encodeURIComponent(`http://outside.localhost:${source.port}/echo?redirect-chain=1`)}`,
  );
  assert.equal(
    chained.headers['x-reqvik'],
    undefined,
    'Extension headers must not leak through a server redirect to an unlisted origin.',
  );
  console.log(
    'PASS: server redirects to unlisted hosts do not carry extension-added headers.',
  );
  const cdp = await context.newCDPSession(options);
  const targets = await cdp.send('Target.getTargets');
  const workerTarget = targets.targetInfos.find(
    (info) => info.type === 'service_worker' && info.url === worker.url(),
  );
  assert.ok(workerTarget);
  await cdp.send('Target.closeTarget', { targetId: workerTarget.targetId });
  assert.equal(
    (await get(tab, `${targetOrigin}/echo?worker-stopped=1`)).headers[
      'x-reqvik'
    ],
    'active',
  );
  assert.equal(
    (await rpc<{ activations: unknown[] }>({ type: 'getState' })).activations
      .length,
    1,
  );
  await cdp.detach();
  console.log(
    'PASS: native rules survive worker termination and activation reconciles on wakeup.',
  );
  const other = await context.newPage();
  await other.goto(`${sourceOrigin}/page`);
  const unaffected = await get(other, `${sourceOrigin}/echo?other-tab=1`);
  assert.equal(unaffected.host, `source.preview.localhost:${source.port}`);
  assert.equal(unaffected.headers['x-reqvik'], undefined);
  const thirdParty = await get(
    tab,
    `http://outside.localhost:${source.port}/echo?third-party=1`,
  );
  assert.equal(thirdParty.headers['x-reqvik'], undefined);
  const wrongPort = await get(
    tab,
    `http://source.preview.localhost:${target.port}/echo?wrong-port=1`,
  );
  assert.equal(wrongPort.headers['x-reqvik'], undefined);
  console.log(
    'PASS: other tabs, third-party hosts, and unlisted ports are unaffected.',
  );
  // Verify native top-domain/initiator constraints with the installed rules.
  const match = async (initiator: string, topUrl: string, id = tabId) =>
    options.evaluate(
      async (request) => chrome.declarativeNetRequest.testMatchOutcome(request),
      {
        url: `${sourceOrigin}/echo`,
        initiator,
        topUrl,
        tabId: id,
        type: 'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
      },
    );
  assert.ok((await match(targetOrigin, targetOrigin)).matchedRules.length);
  assert.equal(
    (await match(targetOrigin, `http://outside.localhost:${source.port}`))
      .matchedRules.length,
    0,
  );
  assert.equal(
    (await match(`http://outside.localhost:${source.port}`, targetOrigin))
      .matchedRules.length,
    0,
  );
  assert.equal(
    (await match(targetOrigin, targetOrigin, -1)).matchedRules.length,
    0,
  );
  console.log(
    'PASS: Chrome’s native matcher rejects unrelated top-level pages, foreign initiators, and background traffic.',
  );
  const outside = await context.newPage();
  await outside.goto(`http://outside.localhost:${source.port}/page`);
  const outsideId = await options.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    outside.url(),
  );
  const emptyPopup = await context.newPage();
  await options.evaluate(
    async (id) => chrome.tabs.update(id, { active: true }),
    outsideId,
  );
  await emptyPopup.goto(`chrome-extension://${extensionId}/popup.html`);
  await emptyPopup
    .getByRole('button', { name: 'Create a profile', exact: true })
    .waitFor();
  assert.equal(await emptyPopup.getByRole('combobox').count(), 0);
  assert.equal(
    await emptyPopup
      .getByRole('button', { name: 'Activate in this tab' })
      .count(),
    0,
  );
  assert.equal(
    await emptyPopup.locator('.scope-summary, .status, footer').count(),
    0,
  );
  await emptyPopup.screenshot({
    path: join(directory, 'unmatched-popup.png'),
  });
  const createdPage = context.waitForEvent('page');
  await emptyPopup
    .getByRole('button', { name: 'Create a profile', exact: true })
    .click();
  const created = await createdPage;
  await created.getByLabel('Request origin', { exact: true }).waitFor();
  assert.equal(
    await created.getByLabel('Request origin', { exact: true }).inputValue(),
    `http://outside.localhost:${source.port}`,
  );
  assert.equal(
    await created.getByLabel('Allowed page domains').inputValue(),
    'outside.localhost',
  );
  assert.equal(
    await created.getByLabel('Profile name', { exact: true }).inputValue(),
    'outside.localhost',
  );
  assert.equal(
    await created
      .getByRole('button', { name: 'Use Example local example' })
      .count(),
    0,
  );
  assert.equal(
    await created.getByRole('heading', { name: 'Check a request' }).count(),
    0,
  );
  // This draft is deliberately unsaved; close without invoking beforeunload.
  await created.close();
  await emptyPopup.close();
  await outside.close();
  console.log(
    'PASS: wildcard scopes activate; popup hides unrelated profiles and pre-fills new profiles on unmatched sites.',
  );

  await tab.goto(`http://outside.localhost:${source.port}/page`);
  await options.waitForFunction(
    async () =>
      (await chrome.runtime.sendMessage({ type: 'getState' })).activations
        .length === 0,
  );
  assert.equal(
    (await get(tab, `${sourceOrigin}/echo?after-leaving=1`)).headers[
      'x-reqvik'
    ],
    undefined,
  );
  await tab.goto(`${sourceOrigin}/page`);
  await activate();
  profile.name = 'Edited';
  await rpc({ type: 'saveDocument', doc: state.doc });
  assert.equal(
    (await rpc<{ activations: unknown[] }>({ type: 'getState' })).activations
      .length,
    0,
  );
  console.log(
    'PASS: leaving scope or editing an active profile disables its tab.',
  );
  await activate();
  await rpc({ type: 'disableAll' });
  assert.equal(
    (
      await options.evaluate(() =>
        chrome.declarativeNetRequest.getSessionRules(),
      )
    ).length,
    0,
  );
  // Switching profiles replaces all previous actions for this tab.
  const headerOnly = structuredClone(profile);
  headerOnly.id = 'headers-only';
  headerOnly.name = 'Headers only';
  delete headerOnly.rules[0].redirectOrigin;
  headerOnly.rules[0].requestHeaders = [
    { operation: 'set', name: 'X-Reqvik', value: 'headers-only' },
  ];
  await rpc({
    type: 'saveDocument',
    doc: { schemaVersion: 1, profiles: [profile, headerOnly] },
  });
  await rpc({ type: 'activate', profileId: headerOnly.id, tabId });
  await tab.goto(`${sourceOrigin}/echo?headers-only=1`);
  assert.equal(tab.url(), `${sourceOrigin}/echo?headers-only=1`);
  assert.equal(
    JSON.parse(await tab.locator('body').innerText()).headers['x-reqvik'],
    'headers-only',
  );
  await activate();
  await tab.goto(`${sourceOrigin}/echo?switched=1`);
  assert.equal(tab.url(), `${targetOrigin}/echo?switched=1`);
  assert.equal(
    JSON.parse(await tab.locator('body').innerText()).headers['x-reqvik'],
    'active',
  );
  console.log(
    'PASS: popup activation and switching to/from a header-only profile work.',
  );
  // Configure the dynamic mode through the editor, then follow PR targets per tab.
  if (!(await options.getByLabel('Override target mode').isVisible()))
    await options.getByText('Advanced options', { exact: true }).click();
  await options.getByLabel('Override target mode').selectOption('current');
  await options
    .getByLabel('Current-page domain pattern')
    .fill('pr-*.review.localhost');
  await options
    .getByRole('button', { name: 'Save profile', exact: true })
    .first()
    .click();
  await options.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
  const dynamic = (
    await rpc<{ doc: import('../src/model').ProfileDocument }>({
      type: 'getState',
    })
  ).doc.profiles.find((p) => p.id === profile.id);
  assert.ok(dynamic);
  assert.deepEqual(dynamic.scope.pageDomains, [
    '*.preview.localhost',
    '*.review.localhost',
  ]);
  assert.equal(
    await options.getByLabel('Allowed page domains').inputValue(),
    '*.preview.localhost\n*.review.localhost',
  );
  assert.equal(dynamic.rules[0].redirectPageDomain, 'pr-*.review.localhost');
  assert.equal(dynamic.rules[0].redirectOrigin, undefined);
  const reviewA = `http://pr-6.review.localhost:${target.port}`;
  const reviewB = `http://pr-7.review.localhost:${source.port}`;
  await tab.goto(`${reviewA}/page`);
  await activate();
  const dynamicPost = await get(tab, `${sourceOrigin}/echo?dynamic=1`, 'POST');
  assert.equal(dynamicPost.host, `pr-6.review.localhost:${target.port}`);
  assert.equal(dynamicPost.url, '/echo?dynamic=1');
  assert.equal(dynamicPost.body, 'preserved-body');
  assert.equal(dynamicPost.headers['x-reqvik'], 'active');
  assert.equal(dynamicPost.headers['x-remove'], undefined);
  assert.equal(
    (await get(tab, `${reviewA}/echo?direct=1`)).headers['x-reqvik'],
    'active',
  );
  const secondReview = await context.newPage();
  await secondReview.goto(`${reviewA}/page?second-tab=1`);
  const secondId = await options.evaluate(async (url) => {
    const id = (await chrome.tabs.query({})).find((t) => t.url === url)?.id;
    if (id === undefined) throw new Error('Review tab not found.');
    return id;
  }, `${reviewA}/page?second-tab=1`);
  await rpc({ type: 'activate', profileId: profile.id, tabId: secondId });
  await tab.goto(`${reviewB}/page`);
  await options.waitForFunction(
    async ({ tabId, origin }) =>
      (await chrome.runtime.sendMessage({ type: 'getState' })).activations.some(
        (a: { tabId: number; pageOrigin: string }) =>
          a.tabId === tabId && a.pageOrigin === origin,
      ),
    { tabId, origin: reviewB },
  );
  assert.equal(
    (await get(tab, `${sourceOrigin}/echo?new-pr=1`)).host,
    `pr-7.review.localhost:${source.port}`,
  );
  assert.equal(
    (await get(tab, `${reviewA}/echo?old-pr=1`)).headers['x-reqvik'],
    undefined,
  );
  assert.equal(
    (await get(secondReview, `${sourceOrigin}/echo?other-tab=1`)).host,
    `pr-6.review.localhost:${target.port}`,
  );
  await secondReview.close();
  const unmatchedReview = `http://other-6.review.localhost:${target.port}`;
  await tab.goto(`${unmatchedReview}/page`);
  await options.waitForFunction(
    async ({ tabId, origin }) =>
      (await chrome.runtime.sendMessage({ type: 'getState' })).activations.some(
        (a: { tabId: number; pageOrigin: string }) =>
          a.tabId === tabId && a.pageOrigin === origin,
      ),
    { tabId, origin: unmatchedReview },
  );
  assert.equal(
    (await get(tab, `${sourceOrigin}/echo?wrong-prefix=1`)).host,
    `source.preview.localhost:${source.port}`,
  );
  assert.equal(
    (await get(tab, `${unmatchedReview}/echo?wrong-prefix-direct=1`)).headers[
      'x-reqvik'
    ],
    undefined,
  );
  await tab.goto(`${targetOrigin}/page`);
  await options.waitForFunction(
    async ({ tabId, origin }) =>
      (await chrome.runtime.sendMessage({ type: 'getState' })).activations.some(
        (a: { tabId: number; pageOrigin: string }) =>
          a.tabId === tabId && a.pageOrigin === origin,
      ),
    { tabId, origin: targetOrigin },
  );
  const outsidePattern = await get(
    tab,
    `${sourceOrigin}/echo?outside-pattern=1`,
  );
  assert.equal(outsidePattern.host, `source.preview.localhost:${source.port}`);
  assert.equal(outsidePattern.headers['x-reqvik'], 'active');
  console.log(
    'PASS: current-page wildcard overrides follow PR navigation, preserve POST bodies and headers, and isolate per-tab targets.',
  );
  // Automatic activation is configured through profile advanced options.
  const autoA = `http://pr-6.auto.localhost:${target.port}`;
  const autoB = `http://pr-7.auto.localhost:${source.port}`;
  const waitAutomatic = (id: number, profileId: string | undefined) =>
    options.waitForFunction(
      async ({ id, profileId }) => {
        const state = await chrome.runtime.sendMessage({ type: 'getState' });
        const entry = state.activations.find(
          (a: { tabId: number }) => a.tabId === id,
        );
        return profileId
          ? entry?.profileId === profileId && entry.automatic === true
          : !entry;
      },
      { id, profileId },
    );
  await rpc({ type: 'deactivate', tabId });
  await tab.goto(`${autoA}/page`);
  await options.getByText('Advanced profile options', { exact: true }).click();
  await options.getByLabel('Activate automatically on matching sites').check();
  await options
    .getByLabel('Automatic activation domain pattern')
    .fill('pr-*.auto.localhost');
  await options
    .getByLabel('Current-page domain pattern')
    .fill('pr-*.auto.localhost');
  await options
    .getByRole('button', { name: 'Save profile', exact: true })
    .first()
    .click();
  await options.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
  const automaticDoc = (
    await rpc<{ doc: import('../src/model').ProfileDocument }>({
      type: 'getState',
    })
  ).doc;
  const autoProfile = automaticDoc.profiles.find((p) => p.id === profile.id);
  assert.ok(autoProfile);
  assert.ok(autoProfile.scope.pageDomains.includes('*.auto.localhost'));
  assert.equal(autoProfile.autoActivateDomain, 'pr-*.auto.localhost');
  await waitAutomatic(tabId, profile.id);
  assert.equal(
    (await get(tab, `${sourceOrigin}/echo?automatic-open-tab=1`)).host,
    `pr-6.auto.localhost:${target.port}`,
  );
  const automaticTab = await context.newPage();
  await automaticTab.goto(`${autoB}/page?automatic-new-tab=1`);
  const automaticId = await options.evaluate(async (url) => {
    const id = (await chrome.tabs.query({})).find((t) => t.url === url)?.id;
    if (id === undefined) throw new Error('Automatic tab not found.');
    return id;
  }, automaticTab.url());
  await waitAutomatic(automaticId, profile.id);
  assert.equal(
    (await get(automaticTab, `${sourceOrigin}/echo?automatic-new-tab=1`)).host,
    `pr-7.auto.localhost:${source.port}`,
  );
  const wrongPrefix = `http://other-6.auto.localhost:${target.port}`;
  await automaticTab.goto(`${wrongPrefix}/page`);
  await waitAutomatic(automaticId, undefined);
  assert.equal(
    (await get(automaticTab, `${sourceOrigin}/echo?automatic-wrong-prefix=1`))
      .headers['x-reqvik'],
    undefined,
  );
  await rpc({ type: 'deactivate', tabId });
  await tab.reload();
  await waitAutomatic(tabId, undefined);
  assert.equal(
    (await get(tab, `${sourceOrigin}/echo?automatic-disabled=1`)).headers[
      'x-reqvik'
    ],
    undefined,
  );
  await tab.goto(`${autoB}/page`);
  await waitAutomatic(tabId, profile.id);
  const autoCdp = await context.newCDPSession(options);
  const stopWorker = async () => {
    const targets = await autoCdp.send('Target.getTargets');
    const target = targets.targetInfos.find(
      (t) =>
        t.type === 'service_worker' &&
        t.url.startsWith(`chrome-extension://${extensionId}/`),
    );
    assert.ok(target);
    await autoCdp.send('Target.closeTarget', { targetId: target.targetId });
  };
  await stopWorker();
  await waitAutomatic(tabId, profile.id);
  assert.equal(
    (await get(tab, `${sourceOrigin}/echo?automatic-worker-wakeup=1`)).host,
    `pr-7.auto.localhost:${source.port}`,
  );
  const manualProfile = structuredClone(autoProfile);
  manualProfile.id = 'manual-precedence';
  manualProfile.name = 'Manual precedence';
  delete manualProfile.autoActivateDomain;
  manualProfile.rules[0].requestHeaders = [
    { operation: 'set', name: 'X-Reqvik', value: 'manual' },
  ];
  await rpc({
    type: 'saveDocument',
    doc: { schemaVersion: 1, profiles: [autoProfile, manualProfile] },
  });
  await rpc({ type: 'activate', profileId: manualProfile.id, tabId });
  await tab.reload();
  assert.equal(
    (await get(tab, `${sourceOrigin}/echo?manual-precedence=1`)).headers[
      'x-reqvik'
    ],
    'manual',
  );
  await rpc({ type: 'disableAll' });
  await tab.goto(`${autoA}/page`);
  await automaticTab.goto(`${autoB}/page`);
  await waitAutomatic(tabId, undefined);
  await waitAutomatic(automaticId, undefined);
  await stopWorker();
  await waitAutomatic(tabId, undefined);
  await rpc({
    type: 'saveDocument',
    doc: { schemaVersion: 1, profiles: [autoProfile] },
  });
  await waitAutomatic(tabId, profile.id);
  await waitAutomatic(automaticId, profile.id);
  await autoCdp.detach();
  await automaticTab.close();
  await options
    .getByLabel('Activate automatically on matching sites')
    .uncheck();
  await options
    .getByRole('button', { name: 'Save profile', exact: true })
    .first()
    .click();
  await options.getByRole('status').filter({ hasText: 'Saved.' }).waitFor();
  await waitAutomatic(tabId, undefined);
  await tab.goto(`${autoB}/page`);
  await waitAutomatic(tabId, undefined);
  console.log(
    'PASS: automatic profiles activate on save and navigation, reject other prefixes, honor manual selection and disable controls, and survive worker wakeups.',
  );
  await rpc({
    type: 'saveDocument',
    doc: { schemaVersion: 1, profiles: [profile, headerOnly] },
  });
  // Persist a nonempty activation before closing the whole browser.
  await tab.goto(`${targetOrigin}/page`);
  await options.screenshot({
    path: join(directory, 'options.png'),
    fullPage: true,
  });
  await activate();
  await tab.close();
  await options.waitForFunction(
    async () =>
      (await chrome.runtime.sendMessage({ type: 'getState' })).activations
        .length === 0,
  );
  console.log('PASS: disable-all and tab closure remove native rules.');
  const restartTab = await context.newPage();
  await restartTab.goto(`${sourceOrigin}/page`);
  const restartId = await options.evaluate(
    async (url) =>
      (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
    `${sourceOrigin}/page`,
  );
  await rpc({ type: 'activate', profileId: profile.id, tabId: restartId });
  assert.deepEqual(errors, []);
  await context.close();
  context = undefined;
  context = await chromium.launchPersistentContext(join(directory, 'browser'), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const restarted = await context.newPage();
  await restarted.goto(`chrome-extension://${extensionId}/options.html`);
  const persisted = await restarted.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'getState' }),
  );
  assert.equal(persisted.doc.profiles[0].name, 'Edited');
  assert.equal(persisted.activations.length, 0);
  console.log(
    'PASS: JSON profiles persist across restart; activations do not.',
  );
  console.log(`Browser test artifacts: ${directory}`);
} finally {
  await context?.close();
  await Promise.all([source.close(), target.close()]);
}
