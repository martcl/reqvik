import type { RequestRule } from '../model';
import { HeaderChangeEditor } from './HeaderChangeEditor';

export function RequestRuleEditor({
  rule,
  index,
  canRemove,
  onChange,
  onRemove,
}: {
  rule: RequestRule;
  index: number;
  canRemove: boolean;
  onChange: (value: RequestRule) => void;
  onRemove: () => void;
}) {
  return (
    <article className="rule">
      <div className="rule-heading">
        <h3>Rule {index + 1}</h3>
        <button
          type="button"
          className="quiet danger"
          disabled={!canRemove}
          onClick={onRemove}
        >
          Remove rule
        </button>
      </div>
      <div className="form-row">
        <label>
          Request origin
          <input
            value={rule.match.origin}
            placeholder="https://www.example.com"
            onChange={(e) =>
              onChange({
                ...rule,
                match: {
                  ...rule.match,
                  origin: e.target.value,
                },
              })
            }
          />
        </label>
        <label className="path-field">
          Path prefix
          <input
            value={rule.match.pathPrefix}
            placeholder="/"
            onChange={(e) =>
              onChange({
                ...rule,
                match: {
                  ...rule.match,
                  pathPrefix: e.target.value,
                },
              })
            }
          />
        </label>
      </div>
      <div className="header-labels">
        <h4>Request headers</h4>
      </div>
      {rule.requestHeaders.map((header, hi) => (
        <HeaderChangeEditor
          key={hi}
          header={header}
          index={hi}
          ruleNumber={index + 1}
          onChange={(change) =>
            onChange({
              ...rule,
              requestHeaders: rule.requestHeaders.map((value, i) =>
                i === hi ? change : value,
              ),
            })
          }
          onRemove={() =>
            onChange({
              ...rule,
              requestHeaders: rule.requestHeaders.filter((_, i) => i !== hi),
            })
          }
        />
      ))}
      {rule.requestHeaders.some((h) =>
        ['authorization', 'cookie'].includes(h.name.toLowerCase()),
      ) && (
        <p className="hint">
          This profile contains authentication headers. Values stay on this
          device and apply to the configured destination, including its redirect
          target.
        </p>
      )}
      <button
        type="button"
        className="secondary"
        onClick={() =>
          onChange({
            ...rule,
            requestHeaders: [
              ...rule.requestHeaders,
              {
                operation: 'set',
                name: '',
                value: '',
              },
            ],
          })
        }
      >
        ＋ Add header
      </button>
      <details className="rule-advanced">
        <summary>
          Advanced options
          {(rule.redirectOrigin || rule.redirectPageDomain !== undefined) && (
            <span className="muted"> · Host override configured</span>
          )}
        </summary>
        <div className="advanced-fields">
          <label>
            Override target mode
            <select
              value={
                rule.redirectPageDomain !== undefined ? 'current' : 'fixed'
              }
              onChange={(e) => {
                const next = { ...rule };
                delete next.redirectOrigin;
                delete next.redirectPageDomain;
                if (e.target.value === 'current') next.redirectPageDomain = '';
                onChange(next);
              }}
            >
              <option value="fixed">Fixed origin</option>
              <option value="current">
                Current page matching a domain pattern
              </option>
            </select>
          </label>
          {rule.redirectPageDomain !== undefined ? (
            <label>
              Current-page domain pattern
              <input
                value={rule.redirectPageDomain}
                placeholder="www-example-com-*.preview.example.com"
                onChange={(e) =>
                  onChange({ ...rule, redirectPageDomain: e.target.value })
                }
              />
            </label>
          ) : (
            <label>
              Host override{' '}
              <span className="muted">(optional target origin)</span>
              <input
                value={rule.redirectOrigin ?? ''}
                placeholder="https://preview.example.com or http://localhost:8080"
                onChange={(e) => {
                  const next = {
                    ...rule,
                  };
                  if (e.target.value) next.redirectOrigin = e.target.value;
                  else delete next.redirectOrigin;
                  onChange(next);
                }}
              />
            </label>
          )}
          {rule.redirectPageDomain !== undefined && (
            <p className="hint">
              On a matching page, redirects the request origin to this tab’s
              current origin, including its scheme and port. The target follows
              navigation between matching sites. Use *.preview.example.com or
              www-example-com-*.preview.example.com. Saving adds the required
              page domain scope; a wildcard within a hostname uses its parent
              domain scope. Outside this pattern, the host override is inactive.
            </p>
          )}
          <p className="hint">
            Keeps the path and query. Headers also apply at the target in this
            tab.
          </p>
        </div>
      </details>
    </article>
  );
}
