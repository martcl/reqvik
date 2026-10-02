import type { HeaderChange } from '../model';

export function HeaderChangeEditor({
  header,
  index,
  ruleNumber,
  onChange,
  onRemove,
}: {
  header: HeaderChange;
  index: number;
  ruleNumber: number;
  onChange: (value: HeaderChange) => void;
  onRemove: () => void;
}) {
  return (
    <div className="header-row">
      <label>
        Operation
        <select
          value={header.operation}
          onChange={(e) =>
            onChange(
              e.target.value === 'set'
                ? {
                    operation: 'set',
                    name: header.name,
                    value: '',
                  }
                : {
                    operation: 'remove',
                    name: header.name,
                  },
            )
          }
        >
          <option value="set">Set</option>
          <option value="remove">Remove</option>
        </select>
      </label>
      <label>
        Header name
        <input
          value={header.name}
          placeholder="X-Debug"
          onChange={(e) =>
            onChange({
              ...header,
              name: e.target.value,
            })
          }
        />
      </label>
      {header.operation === 'set' ? (
        <label>
          Value
          <input
            value={header.value}
            placeholder="1"
            onChange={(e) =>
              onChange({
                ...header,
                value: e.target.value,
              })
            }
          />
        </label>
      ) : (
        <div className="muted removed-label">Header will be removed</div>
      )}
      <button
        type="button"
        className="quiet danger"
        aria-label={`Remove header ${index + 1} from rule ${ruleNumber}`}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
