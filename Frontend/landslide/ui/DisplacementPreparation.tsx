import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import type { PreparedInvestigation } from '../engine/investigation';
import {
  cancelDisplacementJob,
  getDisplacementJob,
  listDisplacementJobs,
  resubmitDisplacementJob,
  type DisplacementJob,
} from '../../src/api/catalog';

const activeStates = new Set(['queued', 'dispatching', 'running']);
const noopTaskActivityChange = () => {};

function elapsed(createdAt: string) {
  const milliseconds = Math.max(0, Date.now() - new Date(createdAt).getTime());
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function chooseAccountJob(jobs: DisplacementJob[], preparation: PreparedInvestigation) {
  const matching = preparation.valid
    ? jobs.filter((candidate) => candidate.aoi_wkt === preparation.payload.aoi_wkt
      && candidate.start_date === preparation.payload.start_date
      && candidate.end_date === preparation.payload.end_date)
    : [];
  // Only an active task is resumable. A cancelled/failed/completed record is
  // history, not the current request, so it must never prevent the account
  // owner from starting a fresh request from the map.
  return matching.find((candidate) => activeStates.has(candidate.state))
    || jobs.find((candidate) => activeStates.has(candidate.state))
    || null;
}

export function DisplacementPreparation({ preparation, onBack, onTaskActivityChange = noopTaskActivityChange, user }: { preparation: PreparedInvestigation; onBack: () => void; onTaskActivityChange?: (active: boolean) => void; user: User }) {
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<DisplacementJob | null>(null);
  const [jobError, setJobError] = useState('');
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [showResubmitConfirmation, setShowResubmitConfirmation] = useState(false);

  const loadAccountJob = useCallback(async () => {
    setJobError('');
    try {
      const jobs = await listDisplacementJobs(user);
      setJob((current) => current && activeStates.has(current.state) ? current : chooseAccountJob(jobs, preparation));
    } catch (error) {
      setJobError(error instanceof Error ? error.message : 'Could not load your displacement jobs.');
    } finally {
      setAccountLoaded(true);
    }
  }, [preparation, user]);

  // Browser refresh and reopening this route only read durable account state.
  useEffect(() => { void loadAccountJob(); }, [loadAccountJob]);

  useEffect(() => {
    if (!job || !activeStates.has(job.state)) return;
    const timer = window.setInterval(() => {
      void getDisplacementJob(job.id, user)
        .then(setJob)
        .catch((error: unknown) => setJobError(error instanceof Error ? error.message : 'Could not refresh the displacement job.'));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [job, user]);

  useEffect(() => {
    if (job) onTaskActivityChange(activeStates.has(job.state));
  }, [job, onTaskActivityChange]);

  // This route is only for an account task already created on the map. It is
  // never a second submission screen, and a direct/expired route returns to
  // the map once the account lookup has completed.
  useEffect(() => {
    if (accountLoaded && !job && !jobError) onBack();
  }, [accountLoaded, job, jobError, onBack]);

  const cancel = useCallback(async () => {
    if (!job || !activeStates.has(job.state) || busy) return;
    setBusy(true);
    setJobError('');
    try {
      const cancelled = await cancelDisplacementJob(job.id, user);
      setJob(cancelled);
      if (cancelled.state === 'cancelled' && cancelled.stage === 'cancelled_by_user') {
        onTaskActivityChange(false);
        onBack();
      }
    } catch (error) {
      setJobError(error instanceof Error ? error.message : 'Could not cancel the displacement job.');
    } finally {
      setBusy(false);
    }
  }, [busy, job, onBack, onTaskActivityChange, user]);

  const confirmResubmit = useCallback(async () => {
    if (!job || !activeStates.has(job.state) || busy) return;
    setBusy(true);
    setJobError('');
    try {
      const replacement = await resubmitDisplacementJob(job.id, crypto.randomUUID(), user);
      setJob(replacement);
      setShowResubmitConfirmation(false);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : 'Could not replace the displacement job.');
    } finally {
      setBusy(false);
    }
  }, [busy, job, user]);

  const hasActiveJob = Boolean(job && activeStates.has(job.state));
  if (!job && !jobError) return null;

  return <main className="nisar-results-main displacement-preparation">
    <section className="nisar-results-summary">
      <span className="result-kicker">DISPLACEMENT PROCESSING</span>
      <h1>Find Displacements</h1>
      <p>Your processing task belongs to this signed-in account and continues if you close the browser. Reopen this page to see its current state.</p>
      {job && <section className="displacement-job-status" aria-live="polite">
        <h2>Processing status</h2>
        <p><b>Status:</b> {job.state}</p><p><b>Job ID:</b> {job.id}</p>
        <p><b>Stage:</b> {job.stage}</p><p><b>Submitted:</b> {new Date(job.created_at).toLocaleString()} · {elapsed(job.created_at)}</p>
        {job.error_message && <p role="alert">{job.error_message}</p>}
        {hasActiveJob && <div className="displacement-task-actions">
          <button type="button" className="demo-button danger-button" disabled={busy} onClick={() => void cancel()}>{busy ? 'Cancelling…' : 'Cancel task'}</button>
          <button type="button" className="investigate-button" disabled={busy} onClick={() => setShowResubmitConfirmation(true)}>Refresh task</button>
        </div>}
        {job.state === 'succeeded' && <>{job.result_summary && <pre tabIndex={0} aria-label="Validated output summary"><code>{JSON.stringify(job.result_summary, null, 2)}</code></pre>}
          {job.artifact_url && <p><a href={job.artifact_url} target="_blank" rel="noreferrer">Open validated outputs</a></p>}</>}
      </section>}

      {showResubmitConfirmation && job && <section className="displacement-resubmit-dialog" role="dialog" aria-modal="true" aria-labelledby="resubmit-title">
        <h2 id="resubmit-title">Refresh this task?</h2>
        <p>The current workflow will be cancelled. A new workflow will start with the exact same saved AOI and dates.</p>
        <div className="displacement-resubmit-actions">
          <button type="button" className="demo-button" disabled={busy} onClick={() => setShowResubmitConfirmation(false)}>Keep current task</button>
          <button type="button" className="investigate-button" disabled={busy} onClick={() => void confirmResubmit()}>{busy ? 'Refreshing…' : 'Cancel and create new task'}</button>
        </div>
      </section>}
      {jobError && <p role="alert">{jobError}</p>}
    </section>
  </main>;
}
