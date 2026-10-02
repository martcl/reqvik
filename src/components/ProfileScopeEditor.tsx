import type { Profile } from '../model';
import { SectionHeading } from './SectionHeading';

export function ProfileScopeEditor({
  value,
  domainText,
  dirty,
  onChange,
  onDomainTextChange,
}: {
  value: Profile;
  domainText: string;
  dirty: boolean;
  onChange: (value: Profile) => void;
  onDomainTextChange: (value: string) => void;
}) {
  return (
    <section className="card">
      <SectionHeading
        step="01"
        title="Profile & scope"
        description="Choose where this profile can run."
      >
        {dirty && <span className="tag">Unsaved</span>}
      </SectionHeading>
      <label>
        Profile name
        <input
          value={value.name}
          maxLength={100}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder="Review app"
        />
      </label>
      <label>
        Allowed page domains
        <textarea
          rows={2}
          value={domainText}
          placeholder={'www.example.com\n*.preview.example.com'}
          onChange={(e) => {
            onDomainTextChange(e.target.value);
          }}
        />
      </label>
      <p className="hint">
        One per line: example.com, *.example.com, or https://*.example.com.
        Includes the base domain and subdomains, on HTTP and HTTPS. Include
        source and target hosts.
      </p>
      <details className="rule-advanced">
        <summary>
          Advanced profile options{' '}
          {value.autoActivateDomain !== undefined && (
            <span className="muted"> · Automatic activation configured</span>
          )}
        </summary>
        <div className="advanced-fields">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={value.autoActivateDomain !== undefined}
              onChange={(e) => {
                const next = { ...value };
                if (e.target.checked) next.autoActivateDomain = '';
                else delete next.autoActivateDomain;
                onChange(next);
              }}
            />
            Activate automatically on matching sites
          </label>
          {value.autoActivateDomain !== undefined && (
            <label>
              Automatic activation domain pattern
              <input
                value={value.autoActivateDomain}
                placeholder="www-example-com-*.preview.example.com"
                onChange={(e) =>
                  onChange({ ...value, autoActivateDomain: e.target.value })
                }
              />
            </label>
          )}
          <p className="hint">
            Save to grant site access and activate on matching open tabs and
            future visits. Supports *.preview.example.com and
            www-example-com-*.preview.example.com. The required page domain
            scope is added automatically. A manually selected profile takes
            precedence. Disable in this tab pauses activation here until you
            visit another origin. Disable all pauses automatic activation until
            you save profiles or restart the browser.
          </p>
        </div>
      </details>
    </section>
  );
}
