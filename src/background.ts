import { parseRequest, type Request, type Response } from './messages';
import {
  type Activation,
  automaticProfile,
  EMPTY_DOCUMENT,
  origin,
  type ProfileDocument,
  pageAllowed,
  requiredPermissions,
  validateDocument,
} from './model';
import { compileRules } from './rules';

async function readDocument(): Promise<ProfileDocument> {
  const { profileDocument } = await chrome.storage.local.get('profileDocument');
  return profileDocument === undefined
    ? EMPTY_DOCUMENT
    : validateDocument(profileDocument);
}
async function activations(): Promise<Activation[]> {
  const { activations = [] } = await chrome.storage.session.get('activations');
  if (!Array.isArray(activations)) return [];
  return activations.filter(
    (a: Activation) =>
      Number.isInteger(a?.tabId) &&
      a.tabId >= 0 &&
      typeof a.profileId === 'string' &&
      (a.pageOrigin === undefined || validOrigin(a.pageOrigin)) &&
      (a.automatic === undefined || typeof a.automatic === 'boolean'),
  );
}
function validOrigin(value: string): boolean {
  try {
    return origin(value) === value;
  } catch {
    return false;
  }
}
function activationAt(entry: Activation, url: string): Activation {
  return { ...entry, pageOrigin: new URL(url).origin };
}
async function badges(active: Activation[], doc: ProfileDocument) {
  await chrome.action.setBadgeText({ text: '' });
  await Promise.all(
    (await chrome.tabs.query({})).map(async (tab) => {
      if (tab.id === undefined) return;
      const entry = active.find((a) => a.tabId === tab.id);
      const name = doc.profiles.find((p) => p.id === entry?.profileId)?.name;
      try {
        await chrome.action.setBadgeText({
          tabId: tab.id,
          text: name ? 'ON' : '',
        });
        await chrome.action.setBadgeBackgroundColor({
          tabId: tab.id,
          color: '#2d6b56',
        });
        await chrome.action.setTitle({
          tabId: tab.id,
          title: name ? `Reqvik — ${name}` : 'Reqvik — inactive',
        });
      } catch {
        /* A tab can close while its badge is being updated. */
      }
    }),
  );
}
async function install(doc: ProfileDocument, active: Activation[]) {
  const rules = compileRules(doc, active);
  for (const regex of new Set(
    rules.map((rule) => rule.condition.regexFilter!),
  )) {
    const result = await chrome.declarativeNetRequest.isRegexSupported({
      regex,
    });
    if (!result.isSupported)
      throw new Error(
        `Chrome cannot support this path matcher: ${result.reason}`,
      );
  }
  const old = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: old.map((rule) => rule.id),
    addRules: rules,
  });
  try {
    await chrome.storage.session.set({ activations: active });
  } catch (error) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: rules.map((rule) => rule.id),
    });
    throw error;
  }
  await badges(active, doc);
}
async function clearAll() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.map((rule) => rule.id),
  });
  await chrome.storage.session.set({ activations: [] });
  await badges([], EMPTY_DOCUMENT);
}
interface AutomaticState {
  autoActivationPaused?: boolean;
  suppressedAutoTabs?: Array<{ tabId: number; pageOrigin: string }>;
}
async function automaticState(): Promise<AutomaticState> {
  return chrome.storage.session.get([
    'autoActivationPaused',
    'suppressedAutoTabs',
  ]);
}
async function resolveActivation(
  doc: ProfileDocument,
  entry: Activation | undefined,
  tabId: number,
  url: string,
  settings: AutomaticState,
): Promise<Activation | undefined> {
  const profile = doc.profiles.find((p) => p.id === entry?.profileId);
  if (
    entry &&
    profile &&
    pageAllowed(profile, url) &&
    (!entry.automatic || automaticProfile(doc, url)?.id === profile.id) &&
    (await chrome.permissions.contains({
      origins: requiredPermissions(profile),
    }))
  )
    return activationAt(entry, url);
  const candidate = automaticProfile(doc, url);
  if (
    !candidate ||
    settings.autoActivationPaused ||
    settings.suppressedAutoTabs?.some(
      (tab) => tab.tabId === tabId && tab.pageOrigin === new URL(url).origin,
    ) ||
    !(await chrome.permissions.contains({
      origins: requiredPermissions(candidate),
    }))
  )
    return undefined;
  return activationAt({ tabId, profileId: candidate.id, automatic: true }, url);
}
async function reconcile() {
  try {
    const doc = await readDocument();
    const existing = await activations();
    const settings = await automaticState();
    const active: Activation[] = [];
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id === undefined) continue;
      const next = await resolveActivation(
        doc,
        existing.find((a) => a.tabId === tab.id),
        tab.id,
        tab.pendingUrl ?? tab.url ?? '',
        settings,
      );
      if (next) active.push(next);
    }
    await install(doc, active);
  } catch (error) {
    await clearAll();
    console.error('Reqvik disabled during reconciliation:', error);
  }
}
// Serialize mutations, including navigation and permission events, across worker wakeups.
let queue: Promise<unknown> = reconcile();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.catch((error) => {
    console.error(error);
  });
  return result;
}
async function handle(message: Request): Promise<Response<Request>> {
  if (message.type === 'disableAll') {
    await chrome.storage.session.set({ autoActivationPaused: true });
    await clearAll();
    return {};
  }
  if (message.type === 'getState') {
    let doc = EMPTY_DOCUMENT,
      warning: string | undefined;
    try {
      doc = await readDocument();
    } catch (error) {
      warning = `Stored profiles are invalid: ${String(error)}`;
    }
    return { doc, activations: await activations(), warning };
  }
  const doc = await readDocument().catch((error) => {
    if (message.type === 'saveDocument') return EMPTY_DOCUMENT;
    throw error;
  });
  const active = await activations();
  if (message.type === 'saveDocument') {
    const next = message.doc;
    // Edits and deletions deactivate the affected profile before applying saved settings.
    const retained = active.filter(
      (a) =>
        JSON.stringify(doc.profiles.find((p) => p.id === a.profileId)) ===
          JSON.stringify(next.profiles.find((p) => p.id === a.profileId)) &&
        next.profiles.some((p) => p.id === a.profileId),
    );
    await install(doc, retained);
    await chrome.storage.local.set({ profileDocument: next });
    if (next.profiles.some((p) => p.autoActivateDomain))
      await chrome.storage.session.set({ autoActivationPaused: false });
    await reconcile();
    return { doc: next };
  }
  const tabId = message.tabId;
  if (message.type === 'deactivate') {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.pendingUrl ?? tab.url ?? '';
    const settings = await automaticState();
    if (validHttpUrl(url))
      await chrome.storage.session.set({
        suppressedAutoTabs: [
          ...(settings.suppressedAutoTabs ?? []).filter(
            (tab) => tab.tabId !== tabId,
          ),
          { tabId, pageOrigin: new URL(url).origin },
        ],
      });
    await install(
      doc,
      active.filter((a) => a.tabId !== tabId),
    );
    return {};
  }
  if (message.type === 'activate') {
    const profile = doc.profiles.find((p) => p.id === message.profileId);
    if (!profile) throw new Error('Profile not found.');
    const tab = await chrome.tabs.get(tabId);
    if (!pageAllowed(profile, tab.pendingUrl ?? tab.url ?? ''))
      throw new Error(
        'This tab is outside the profile’s allowed page domains.',
      );
    if (
      !(await chrome.permissions.contains({
        origins: requiredPermissions(profile),
      }))
    )
      throw new Error('Site permission is required before activation.');
    const settings = await automaticState();
    await chrome.storage.session.set({
      suppressedAutoTabs: (settings.suppressedAutoTabs ?? []).filter(
        (tab) => tab.tabId !== tabId,
      ),
    });
    await install(doc, [
      ...active.filter((a) => a.tabId !== tabId),
      activationAt(
        { tabId, profileId: profile.id },
        tab.pendingUrl ?? tab.url ?? '',
      ),
    ]);
    return {};
  }
  throw new Error('Unknown request.');
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const pages = ['popup.html', 'options.html'].map((path) =>
    chrome.runtime.getURL(path),
  );
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url ||
    !pages.includes(sender.url.split(/[?#]/)[0])
  )
    return;
  enqueue(() => handle(parseRequest(message))).then(
    (data) => respond({ ok: true, ...data }),
    (error) =>
      respond({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
  return true;
});
function validHttpUrl(url: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
function checkNavigation(tabId: number, url: string) {
  void enqueue(async () => {
    const doc = await readDocument();
    const active = await activations();
    const entry = active.find((a) => a.tabId === tabId);
    const settings = await automaticState();
    if (
      settings.suppressedAutoTabs?.some(
        (tab) =>
          tab.tabId === tabId &&
          (!validHttpUrl(url) || tab.pageOrigin !== new URL(url).origin),
      )
    ) {
      settings.suppressedAutoTabs = settings.suppressedAutoTabs.filter(
        (tab) => tab.tabId !== tabId,
      );
      await chrome.storage.session.set({
        suppressedAutoTabs: settings.suppressedAutoTabs,
      });
    }
    const next = await resolveActivation(doc, entry, tabId, url, settings);
    if (JSON.stringify(next) !== JSON.stringify(entry))
      await install(doc, [
        ...active.filter((a) => a.tabId !== tabId),
        ...(next ? [next] : []),
      ]);
  });
}
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) checkNavigation(details.tabId, details.url);
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) checkNavigation(details.tabId, details.url);
});
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  void chrome.tabs
    .get(details.tabId)
    .then((tab) => {
      if (tab.url) checkNavigation(details.tabId, tab.url);
    })
    .catch(() => {
      /* The tab may have closed. */
    });
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url) checkNavigation(id, change.url);
});
chrome.tabs.onRemoved.addListener((id) => {
  void enqueue(async () => {
    const settings = await automaticState();
    await chrome.storage.session.set({
      suppressedAutoTabs: (settings.suppressedAutoTabs ?? []).filter(
        (tab) => tab.tabId !== id,
      ),
    });
    await install(
      await readDocument(),
      (await activations()).filter((a) => a.tabId !== id),
    );
  });
});
chrome.permissions.onRemoved.addListener(() => {
  void enqueue(reconcile);
});
chrome.permissions.onAdded.addListener(() => {
  void enqueue(reconcile);
});
async function startSession() {
  await chrome.storage.session.set({
    autoActivationPaused: false,
    suppressedAutoTabs: [],
  });
  await clearAll();
  await reconcile();
}
chrome.runtime.onInstalled.addListener(() => {
  void enqueue(startSession);
});
chrome.runtime.onStartup.addListener(() => {
  void enqueue(startSession);
});
