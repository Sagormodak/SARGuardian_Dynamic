import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { copyPreparation, type PreparedInvestigation } from '../engine/investigation';
import { createDisplacementJob, getDisplacementJob, listDisplacementJobs, resubmitDisplacementJob, type DisplacementJob } from '../../src/api/catalog';

const activeStates = new Set(['queued', 'dispatching', 'running']);

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
  return matching.find((candidate) => activeStates.has(candidate.state))
    || matching[0]
    || jobs.find((candidate) => activeStates.has(candidate.state))
    || jobs[0]
    || null;
}

export function DisplacementPreparation({ preparation, onBack, user }: { preparation: PreparedInvestigation; onBack: () => void; user: User }) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<DisplacementJob | null>(null);
  const [jobError, setJobError] = useState('');
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [showResubmitConfirmation, setShowResubmitConfirmation] = useState(false);
  const copying = useRef(false);

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

  // This only reads account-persisted state. No page-load effect submits work.
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

  const copy = async (kind: 'wkt' | 'payload') => {
    if (!preparation.valid || copying.current) return;
    copying.current = true;
    setBusy(true);
    try {
      await copyPreparation(preparation.payload, kind, (text) => navigator.clipboard.writeText(text));
      setFeedback(kind === 'wkt' ? 'WKT copied.' : 'Payload copied.');
    } catch {
      setFeedback('Copy failed. Select and copy the text below manually.');
    } finally {
      copying.current = false;
      setBusy(false);
    }
  };

  const submit = useCallback(async () => {
    if (!preparation.valid || busy) return;
    setBusy(true);
    setJobError('');
    try {
      const created = await createDisplacementJob({
        aoiWkt: preparation.payload.aoi_wkt,
        startDate: preparation.payload.start_date,
        endDate: preparation.payload.end_date,
        idempotencyKey: crypto.randomUUID(),
      }, user);
      setJob(created);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : 'Could not submit the displacement job.');
    } finally {
      setBusy(false);
    }
  }, [busy, preparation, user]);

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
  return <main className="nisar-results-main displacement-preparation">
    <section className="nisar-results-summary">
      <span className="result-kicker">DISPLACEMENT PREPARATION</span>
      <h1>Find Displacements</h1>
      <p>Processing belongs to your signed-in account and continues after this browser is closed. Returning to this page shows the latest saved job state.</p>
      <button type="button" className="demo-button" onClick={onBack}>Back to map</button>

      {preparation.valid && <>
        <dl className="preparation-dates"><div><dt>Start date</dt><dd>{preparation.payload.start_date}</dd></div><div><dt>End date</dt><dd>{preparation.payload.end_date}</dd></div></dl>
        <h2>Selected AOI · WGS84</h2>
        <button type="button" className="demo-button" disabled={busy} onClick={() => void copy('wkt')}>Copy WKT</button>
        <pre tabIndex={0} aria-label="Selected AOI WKT"><code>{preparation.payload.aoi_wkt}</code></pre>
        <h2>Analysis payload</h2>
        <button type="button" className="demo-button" disabled={busy} onClick={() => void copy('payload')}>Copy Payload</button>
        <pre tabIndex={0} aria-label="Displacement payload"><code>{JSON.stringify(preparation.payload, null, 2)}</code></pre>
      </>}

      {!hasActiveJob && preparation.valid && <button type="button" className="investigate-button" disabled={busy || !accountLoaded} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Start displacement processing'}</button>}
      {!preparation.valid && !job && <p role="alert">{preparation.errors.join(' ')} Return to the map to prepare a new request.</p>}

      {job && <section className="displacement-job-status" aria-live="polite">
        <h2>Processing status</h2>
        <p><b>Status:</b> {job.state}</p><p><b>Job ID:</b> {job.id}</p>
        <p><b>Stage:</b> {job.stage}</p><p><b>Submitted:</b> {new Date(job.created_at).toLocaleString()} · {elapsed(job.created_at)}</p>
        {job.github_run_url && <p><a href={job.github_run_url} target="_blank" rel="noreferrer">Open GitHub Actions run</a></p>}
        {job.error_message && <p role="alert">{job.error_message}</p>}
        {hasActiveJob && <button type="button" className="demo-button" disabled={busy} onClick={() => setShowResubmitConfirmation(true)}>Refresh / resubmit</button>}
        {job.state === 'succeeded' && <><p>Scientific workflow completed and reported validated per-product screening outputs.</p>
          {job.result_summary && <pre tabIndex={0} aria-label="Validated output summary"><code>{JSON.stringify(job.result_summary, null, 2)}</code></pre>}
          {job.artifact_url && <p><a href={job.artifact_url} target="_blank" rel="noreferrer">Open validated outputs</a></p>}</>}
      </section>}

      {showResubmitConfirmation && job && <section className="displacement-resubmit-dialog" role="dialog" aria-modal="true" aria-labelledby="resubmit-title">
        <h2 id="resubmit-title">Start a replacement workflow?</h2>
        <p>This cancels the current GitHub Actions workflow first. A new workflow will then be created from the same saved AOI and dates.</p>
        <div className="displacement-resubmit-actions">
          <button type="button" className="demo-button" disabled={busy} onClick={() => setShowResubmitConfirmation(false)}>Keep current workflow</button>
          <button type="button" className="investigate-button" disabled={busy} onClick={() => void confirmResubmit()}>{busy ? 'Replacing…' : 'Cancel and start new workflow'}</button>
        </div>
      </section>}
      {jobError && <p role="alert">{jobError}</p>}
      <p role="status" aria-live="polite">{feedback}</p>
    </section>
  </main>;
}
