export const ERROR_TOAST_DURATION_MS = 10_000;

type ToastDismissHandler = (message: string) => void;

export function scheduleErrorToastDismissal(message: string, onDismiss: ToastDismissHandler): () => void {
  let active = true;
  const timer = setTimeout(() => {
    if (active) onDismiss(message);
  }, ERROR_TOAST_DURATION_MS);

  return () => {
    active = false;
    clearTimeout(timer);
  };
}
