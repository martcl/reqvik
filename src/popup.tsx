import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { errorMessage, getState, send } from './client';
import { Brand } from './components/Brand';
import { FeedbackMessage } from './components/FeedbackMessage';
import { useExtensionState } from './hooks/useExtensionState';
import { pageAllowed, requiredPermissions } from './model';
import './styles.css';

async function loadPopupState() {
  const [state, tabs] = await Promise.all([
    getState(),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  const tab = tabs[0];
  const matching = state.doc.profiles.filter((profile) =>
    pageAllowed(profile, tab?.pendingUrl ?? tab?.url ?? ''),
  );
  const active = matching.find(
    (profile) =>
      profile.id ===
      state.activations.find((activation) => activation.tabId === tab?.id)
        ?.profileId,
  );
  return { ...state, tab, matching, active };
}

function Popup() {
  const { state, refresh, error, setError } = useExtensionState(loadPopupState);
  const tab = state?.tab;
  const [selected, select] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const matching = state?.matching ?? [];
  const active = state?.active;
  useEffect(() => {
    if (!state) return;
    select((value) =>
      state.matching.some((profile) => profile.id === value)
        ? value
        : (state.active?.id ?? state.matching[0]?.id ?? ''),
    );
  }, [state]);
  const profile =
    matching.find((p) => p.id === selected) ?? active ?? matching[0];
  async function run(action: () => Promise<unknown>, text: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
      setNotice(text);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  function createProfile() {
    const url = new URL(chrome.runtime.getURL('options.html'));
    url.searchParams.set('create', '1');
    try {
      const current = new URL(tab?.pendingUrl ?? tab?.url ?? '');
      if (['http:', 'https:'].includes(current.protocol))
        url.searchParams.set('origin', current.origin);
    } catch {
      /* Start an empty profile for browser-internal pages. */
    }
    void chrome.tabs.create({ url: url.href });
  }
  let hostname = '';
  try {
    hostname = new URL(tab?.pendingUrl ?? tab?.url ?? '').hostname;
  } catch {
    /* Tab may have no readable URL. */
  }
  return (
    <main className="popup">
      <header>
        <Brand />
        <button
          type="button"
          className="quiet"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          Profiles ↗
        </button>
      </header>
      <FeedbackMessage message={state?.warning} />
      {!state && !error && <p>Loading profiles…</p>}
      {state && !matching.length && (
        <section className="empty popup-empty">
          <p>Create a profile for this site to add host overrides.</p>
          <button type="button" className="wide" onClick={createProfile}>
            Create a profile
          </button>
        </section>
      )}
      {state && matching.length > 0 && (
        <>
          <div className={`status ${active ? 'enabled' : ''}`}>
            <span className="dot" />
            {active ? active.name : 'No modifications active'}
            <small>THIS TAB</small>
          </div>
          <p className="tab-url">{hostname}</p>
          <label>
            Profile
            <select
              value={profile?.id ?? ''}
              disabled={busy}
              onChange={(e) => select(e.target.value)}
            >
              {matching.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {profile && (
            <section className="scope-summary">
              <h3>Applies only in this tab</h3>
              {profile.autoActivateDomain && (
                <p className="hint">
                  Activates automatically on{' '}
                  <code>{profile.autoActivateDomain}</code>
                </p>
              )}
              {profile.rules.map((r) => (
                <p key={r.id}>
                  <code>
                    {r.match.origin}
                    {r.match.pathPrefix}
                  </code>
                  {r.redirectOrigin && (
                    <>
                      {' '}
                      → <code>{r.redirectOrigin}</code>
                    </>
                  )}
                  <br />
                  <span className="muted">
                    {r.requestHeaders.length} header change
                    {r.requestHeaders.length === 1 ? '' : 's'}
                  </span>
                </p>
              ))}
            </section>
          )}
          <button
            type="button"
            className="wide"
            disabled={!profile || busy || tab?.id === undefined}
            onClick={() => {
              if (!profile || tab?.id === undefined) return;
              const tabId = tab.id;
              void run(async () => {
                const granted = await chrome.permissions.request({
                  origins: requiredPermissions(profile),
                });
                if (!granted)
                  throw new Error(
                    'Site permission was declined. The profile was not activated.',
                  );
                await send({
                  type: 'activate',
                  tabId,
                  profileId: profile.id,
                });
              }, 'Active in this tab. Reload the page to apply changes.');
            }}
          >
            Activate in this tab
          </button>
          {active && (
            <button
              type="button"
              className="secondary wide"
              disabled={busy}
              onClick={() => {
                if (tab?.id === undefined) return;
                const tabId = tab.id;
                void run(
                  () =>
                    send({
                      type: 'deactivate',
                      tabId,
                    }),
                  'Disabled in this tab. Automatic activation resumes when you visit another origin.',
                );
              }}
            >
              Disable in this tab
            </button>
          )}
          <footer>
            <span>{state.activations.length} active tabs</span>
            <button
              type="button"
              className="quiet danger"
              disabled={busy || !state.activations.length}
              onClick={() => {
                void run(
                  () => send({ type: 'disableAll' }),
                  'All modifications disabled. Automatic activation is paused until profiles are saved or the browser restarts.',
                );
              }}
            >
              Disable all
            </button>
          </footer>
        </>
      )}
      <FeedbackMessage message={error} />
      <FeedbackMessage
        message={matching.length > 0 ? notice : undefined}
        kind="notice"
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Popup />);
