import type { Profile } from '../model';
import { Brand } from './Brand';

export function ProfileSidebar({
  profiles,
  selectedId,
  busy,
  ready,
  activationCount,
  onSelect,
  onCreate,
  onDisableAll,
}: {
  profiles: Profile[];
  selectedId?: string;
  busy: boolean;
  ready: boolean;
  activationCount: number;
  onSelect: (profile: Profile) => void;
  onCreate: () => void;
  onDisableAll: () => void;
}) {
  return (
    <aside className="sidebar">
      <Brand />
      <p className="eyebrow">REQUEST PROFILES</p>
      <nav aria-label="Profiles">
        {profiles.map((profile) => (
          <button
            type="button"
            key={profile.id}
            className={`profile-item ${profile.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(profile)}
            disabled={busy}
          >
            <span>{profile.name}</span>
            <small>{profile.rules.length} rules</small>
          </button>
        ))}
      </nav>
      <button
        type="button"
        className="secondary wide"
        disabled={busy || !ready}
        onClick={() => onCreate()}
      >
        ＋ New profile
      </button>
      <div className="sidebar-bottom">
        <p>Saved locally · JSON v1</p>
        <p>
          Activate profiles from the toolbar. Each activation belongs to one
          tab.
        </p>
        <button
          type="button"
          className="secondary wide"
          disabled={busy || !activationCount}
          onClick={onDisableAll}
        >
          Disable all ({activationCount} tabs)
        </button>
      </div>
    </aside>
  );
}
