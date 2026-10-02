export function FeedbackMessage({
  message,
  kind = 'error',
}: {
  message?: string;
  kind?: 'error' | 'notice';
}) {
  if (!message) return null;
  return (
    <p className={kind} role={kind === 'error' ? 'alert' : 'status'}>
      {message}
    </p>
  );
}
