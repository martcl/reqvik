import { useEffect, useRef, useState } from 'react';
import { errorMessage, getState, send } from '../client';
import {
  EMPTY_DOCUMENT,
  newProfile,
  origin,
  overrideScopeDomain,
  type Profile,
  pageAllowed,
  pageDomainHost,
  requiredPermissions,
  validateDocument,
} from '../model';
import { useExtensionState } from './useExtensionState';

interface EditorDraft {
  profile?: Profile;
  domainText: string;
  dirty: boolean;
}

function savedDraft(profile?: Profile): EditorDraft {
  return {
    profile: profile ? structuredClone(profile) : undefined,
    domainText: profile?.scope.pageDomains.join('\n') ?? '',
    dirty: false,
  };
}

function initialDraft(profile?: Profile): EditorDraft {
  const params = new URLSearchParams(window.location.search);
  if (params.get('create') !== '1') return savedDraft(profile);
  const created = newProfile();
  try {
    const source = origin(params.get('origin') ?? '');
    const hostname = new URL(source).hostname;
    created.name = hostname;
    created.scope.pageDomains = [hostname];
    created.rules[0].match.origin = source;
  } catch {
    /* No valid site supplied; start with an empty profile. */
  }
  window.history.replaceState(null, '', window.location.pathname);
  return { ...savedDraft(created), dirty: true };
}

export function useProfileEditor() {
  const {
    state: loaded,
    refresh,
    error,
    setError,
  } = useExtensionState(getState);
  const state = loaded ?? { doc: EMPTY_DOCUMENT, activations: [] };
  const [editor, setEditor] = useState<EditorDraft>(savedDraft());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const initialized = useRef(false);

  useEffect(() => {
    if (!loaded) return;
    if (!initialized.current) {
      initialized.current = true;
      setEditor(initialDraft(loaded.doc.profiles[0]));
      return;
    }
    // Use the latest draft when storage changes; never replace unsaved edits.
    setEditor((current) => {
      if (current.dirty || !current.profile) return current;
      const latest =
        loaded.doc.profiles.find((p) => p.id === current.profile?.id) ??
        loaded.doc.profiles[0];
      return savedDraft(latest);
    });
  }, [loaded]);

  useEffect(() => {
    if (!editor.dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editor.dirty]);

  function choose(profile: Profile) {
    if (editor.dirty && !window.confirm('Discard unsaved changes?')) return;
    setEditor({
      ...savedDraft(profile),
      dirty: !state.doc.profiles.some((p) => p.id === profile.id),
    });
    setError('');
    setNotice('');
  }

  function edit(profile: Profile) {
    setEditor((current) => ({ ...current, profile, dirty: true }));
    setNotice('');
  }

  function editDomains(domainText: string) {
    setEditor((current) => {
      if (!current.profile) return current;
      return {
        domainText,
        dirty: true,
        profile: {
          ...current.profile,
          scope: {
            pageDomains: domainText
              .split(/[\n,]/)
              .map((value) => value.trim())
              .filter(Boolean),
          },
        },
      };
    });
    setNotice('');
  }

  async function run(action: () => Promise<void>, text: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(text);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const draft = editor.profile;
    if (!draft) return;
    await run(
      async () => {
        const scopedDraft = structuredClone(draft);
        for (const domain of [
          scopedDraft.autoActivateDomain,
          ...scopedDraft.rules.map((rule) => rule.redirectPageDomain),
        ]) {
          if (!domain) continue;
          try {
            const pattern = overrideScopeDomain(domain.trim());
            if (!pageAllowed(scopedDraft, `https://${pageDomainHost(pattern)}`))
              scopedDraft.scope.pageDomains.push(pattern);
          } catch {
            // Leave invalid patterns for document validation to report at their field.
          }
        }
        const doc = validateDocument({
          schemaVersion: 1,
          profiles: [
            ...state.doc.profiles.filter((p) => p.id !== draft.id),
            scopedDraft,
          ],
        });
        const saved = doc.profiles.find((p) => p.id === draft.id);
        if (
          saved?.autoActivateDomain &&
          !(await chrome.permissions.request({
            origins: requiredPermissions(saved),
          }))
        )
          throw new Error(
            'Site permission was declined. The profile was not saved.',
          );
        await send({ type: 'saveDocument', doc });
        const next = await refresh();
        setEditor(savedDraft(next.doc.profiles.find((p) => p.id === draft.id)));
      },
      draft.autoActivateDomain
        ? 'Saved. This profile activates automatically on matching sites.'
        : 'Saved. Activate from the toolbar; edited profiles are disabled in active tabs.',
    );
  }

  async function remove() {
    const draft = editor.profile;
    if (
      !draft ||
      !window.confirm(
        `Delete “${draft.name}”? Its active tabs will be disabled.`,
      )
    )
      return;
    await run(async () => {
      await send({
        type: 'saveDocument',
        doc: {
          schemaVersion: 1,
          profiles: state.doc.profiles.filter((p) => p.id !== draft.id),
        },
      });
      const next = await refresh();
      setEditor(savedDraft(next.doc.profiles[0]));
    }, 'Profile deleted.');
  }

  async function disableAll() {
    await run(async () => {
      await send({ type: 'disableAll' });
      await refresh();
    }, 'All modifications disabled. Automatic activation is paused until profiles are saved or the browser restarts.');
  }

  return {
    state,
    draft: editor.profile,
    domainText: editor.domainText,
    dirty: editor.dirty,
    ready: !!loaded,
    busy,
    error,
    notice,
    choose,
    edit,
    editDomains,
    save,
    remove,
    disableAll,
  };
}
