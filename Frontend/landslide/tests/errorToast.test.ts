import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_TOAST_DURATION_MS, scheduleErrorToastDismissal } from '../ui/errorToast';

describe('error toast dismissal timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps an error visible before ten seconds and dismisses it at ten seconds', () => {
    const onDismiss = vi.fn();
    scheduleErrorToastDismissal('Area is too large.', onDismiss);

    vi.advanceTimersByTime(ERROR_TOAST_DURATION_MS - 1);
    expect(onDismiss).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledWith('Area is too large.');
  });

  it('supports immediate dismissal and cleans up replaced toast timers', () => {
    const oldDismiss = vi.fn();
    const newDismiss = vi.fn();
    const cancelOld = scheduleErrorToastDismissal('Old error', oldDismiss);
    cancelOld();
    scheduleErrorToastDismissal('New error', newDismiss);

    vi.advanceTimersByTime(ERROR_TOAST_DURATION_MS);

    expect(oldDismiss).not.toHaveBeenCalled();
    expect(newDismiss).toHaveBeenCalledWith('New error');
  });
});
