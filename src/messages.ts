import {
  type Activation,
  type ProfileDocument,
  validateDocument,
} from './model';

export interface State {
  doc: ProfileDocument;
  activations: Activation[];
  warning?: string;
}

export type Request =
  | { type: 'getState' }
  | { type: 'saveDocument'; doc: ProfileDocument }
  | { type: 'activate'; tabId: number; profileId: string }
  | { type: 'deactivate'; tabId: number }
  | { type: 'disableAll' };

export interface ResponseByType {
  getState: State;
  saveDocument: { doc: ProfileDocument };
  activate: Record<string, never>;
  deactivate: Record<string, never>;
  disableAll: Record<string, never>;
}

export type Response<R extends Request> = ResponseByType[R['type']];

// Types protect callers; this validates messages crossing the runtime boundary.
export function parseRequest(input: unknown): Request {
  if (!input || typeof input !== 'object' || !('type' in input)) {
    throw new Error('Unknown request.');
  }
  switch (input.type) {
    case 'getState':
    case 'disableAll':
      return { type: input.type };
    case 'saveDocument':
      return {
        type: input.type,
        doc: validateDocument('doc' in input ? input.doc : undefined),
      };
    case 'activate':
    case 'deactivate': {
      if (
        !('tabId' in input) ||
        typeof input.tabId !== 'number' ||
        !Number.isInteger(input.tabId) ||
        input.tabId < 0
      ) {
        throw new Error('A valid tab is required.');
      }
      if (input.type === 'deactivate')
        return { type: input.type, tabId: input.tabId };
      if (
        !('profileId' in input) ||
        typeof input.profileId !== 'string' ||
        !input.profileId
      ) {
        throw new Error('Profile not found.');
      }
      return {
        type: input.type,
        tabId: input.tabId,
        profileId: input.profileId,
      };
    }
    default:
      throw new Error('Unknown request.');
  }
}
