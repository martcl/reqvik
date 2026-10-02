import type { Request, Response } from './messages';

export async function send<R extends Request>(
  message: R,
): Promise<Response<R>> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok)
    throw new Error(
      response?.error ??
        'The extension did not respond. Reload it in chrome://extensions.',
    );
  return response;
}
export const getState = () => send({ type: 'getState' });
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
