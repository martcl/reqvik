import { createRoot } from 'react-dom/client';
import { FeedbackMessage } from './components/FeedbackMessage';
import { ProfileScopeEditor } from './components/ProfileScopeEditor';
import { ProfileSidebar } from './components/ProfileSidebar';
import { RequestRuleEditor } from './components/RequestRuleEditor';
import { SectionHeading } from './components/SectionHeading';
import { useProfileEditor } from './hooks/useProfileEditor';
import { newProfile, newRule } from './model';
import './styles.css';

function Options() {
  const {
    state,
    draft,
    domainText,
    dirty,
    ready,
    busy,
    error,
    notice,
    choose,
    edit,
    editDomains,
    save,
    remove,
    disableAll,
  } = useProfileEditor();
  return (
    <div className="app-shell">
      <ProfileSidebar
        profiles={state.doc.profiles}
        selectedId={draft?.id}
        busy={busy}
        ready={ready}
        activationCount={state.activations.length}
        onSelect={choose}
        onCreate={() => choose(newProfile())}
        onDisableAll={() => {
          void disableAll();
        }}
      />
      <main className="editor">
        <header className="editor-header">
          <div>
            <h1>
              {draft ? draft.name || 'New profile' : 'Your request workspace'}
            </h1>
          </div>
          {draft && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void save();
              }}
            >
              {busy ? 'Saving…' : 'Save profile'}
            </button>
          )}
        </header>
        <FeedbackMessage message={state.warning} />
        <FeedbackMessage message={error} />
        <FeedbackMessage message={notice} kind="notice" />
        {!ready && !error && <p>Loading profiles…</p>}
        {ready && !draft && (
          <section className="card empty">
            <h2>Start with a focused profile</h2>
            <p>
              Group your host overrides and headers, then choose the pages where
              they may apply.
            </p>
            <button type="button" onClick={() => choose(newProfile())}>
              Create a profile
            </button>
          </section>
        )}
        {draft && (
          <fieldset disabled={busy} className="editor-fields">
            <ProfileScopeEditor
              value={draft}
              domainText={domainText}
              dirty={dirty}
              onChange={edit}
              onDomainTextChange={editDomains}
            />
            <section className="card">
              <SectionHeading
                step="02"
                title="Request rules"
                description="Set headers, change destinations, or do both."
              />
              {draft.rules.map((rule, index) => (
                <RequestRuleEditor
                  key={rule.id}
                  rule={rule}
                  index={index}
                  canRemove={draft.rules.length > 1}
                  onChange={(next) =>
                    edit({
                      ...draft,
                      rules: draft.rules.map((value) =>
                        value.id === rule.id ? next : value,
                      ),
                    })
                  }
                  onRemove={() =>
                    edit({
                      ...draft,
                      rules: draft.rules.filter(
                        (value) => value.id !== rule.id,
                      ),
                    })
                  }
                />
              ))}
              <button
                type="button"
                className="secondary"
                disabled={draft.rules.length >= 50}
                onClick={() =>
                  edit({
                    ...draft,
                    rules: [...draft.rules, newRule()],
                  })
                }
              >
                ＋ Add rule
              </button>
            </section>
            <details className="card">
              <summary>Profile JSON · schema version 1</summary>
              <p className="hint">
                Read-only preview of this profile’s portable data structure.
                Activation and permissions are stored separately.
              </p>
              <pre>
                {JSON.stringify(
                  { schemaVersion: 1, profiles: [draft] },
                  null,
                  2,
                )}
              </pre>
            </details>
            <div className="editor-footer">
              <button
                type="button"
                className="quiet danger"
                onClick={() => {
                  void remove();
                }}
              >
                Delete profile
              </button>
              <span className="muted">
                {draft.autoActivateDomain
                  ? 'Saving enables automatic activation on matching sites.'
                  : 'Saving does not activate modifications.'}
              </span>
              <button
                type="button"
                onClick={() => {
                  void save();
                }}
              >
                Save profile
              </button>
            </div>
          </fieldset>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Options />);
