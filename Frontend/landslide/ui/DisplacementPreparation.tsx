import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { copyPreparation, type PreparedInvestigation } from '../engine/investigation';
import { createDisplacementJob, getDisplacementJob, type DisplacementJob } from '../../src/api/catalog';

const activeStates = new Set(['queued', 'dispatching', 'running']);

function elapsed(createdAt: string) {
  const milliseconds = Math.max(0, Date.now() - new Date(createdAt).getTime());
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function jobKey(payload: { aoi_wkt: string; start_date: string; end_date: string }) {
  return `sarguardian-displacement:${payload.aoi_wkt}:${payload.start_date}:${payload.end_date}`;
}

export function DisplacementPreparation({ preparation, onBack, user, autoStartRequest = 0 }: { preparation: PreparedInvestigation; onBack: () => void; user: User; autoStartRequest?: number }) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<DisplacementJob | null>(null);
  const [jobError, setJobError] = useState('');
  const [restoredRequest, setRestoredRequest] = useState<number | null>(null);
  const copying = useRef(false);
  const idempotency = useRef<{ payload: string; key: string } | null>(null);
  const autoStartedRequest = useRef(0);
  useEffect(() => {
    let active = true;
    if (!preparation.valid) {
      setRestoredRequest(autoStartRequest);
      return undefined;
    }
    const saved = sessionStorage.getItem(jobKey(preparation.payload));
    if (!saved) {
      setRestoredRequest(autoStartRequest);
      return undefined;
    }
    void getDisplacementJob(saved, user)
      .then((savedJob) => { if (active) setJob(savedJob); })
      .catch(() => sessionStorage.removeItem(jobKey(preparation.payload)))
      .finally(() => { if (active) setRestoredRequest(autoStartRequest); });
    return () => { active = false; };
  }, [autoStartRequest, preparation, user]);
  useEffect(() => {
    if (!job || !activeStates.has(job.state)) return;
    const timer = window.setInterval(() => {
      void getDisplacementJob(job.id, user).then(setJob).catch((error: unknown) => setJobError(error instanceof Error ? error.message : 'Could not refresh the displacement job.'));
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
    } catch { setFeedback('Copy failed. Select and copy the text below manually.'); }
    finally { copying.current = false; setBusy(false); }
  };
  const submit = useCallback(async () => {
    if (!preparation.valid || busy) return;
    setBusy(true); setJobError('');
    try {
      const payloadFingerprint = JSON.stringify(preparation.payload);
      if (!idempotency.current || idempotency.current.payload !== payloadFingerprint) {
        idempotency.current = { payload: payloadFingerprint, key: crypto.randomUUID() };
      }
      const created = await createDisplacementJob({
        aoiWkt: preparation.payload.aoi_wkt, startDate: preparation.payload.start_date,
        endDate: preparation.payload.end_date, idempotencyKey: idempotency.current.key,
      }, user);
      sessionStorage.setItem(jobKey(preparation.payload), created.id);
      setJob(created);
    } catch (error) { setJobError(error instanceof Error ? error.message : 'Could not submit the displacement job.'); }
    finally { setBusy(false); }
  }, [busy, preparation, user]);
  useEffect(() => {
    if (!autoStartRequest || restoredRequest !== autoStartRequest || !preparation.valid || busy) return;
    if (autoStartedRequest.current === autoStartRequest) return;
    if (job && activeStates.has(job.state)) return;
    autoStartedRequest.current = autoStartRequest;
    void submit();
  }, [autoStartRequest, busy, job, preparation.valid, restoredRequest, submit]);
  return <main className="nisar-results-main displacement-preparation">
    <section className="nisar-results-summary">
      <span className="result-kicker">DISPLACEMENT PREPARATION</span>
      <h1>Find Displacements</h1>
      <p>Submit the selected AOI and dates to the configured scientific workflow. Results are accepted only after the worker verifies completion.</p>
      <button type="button" className="demo-button" onClick={onBack}>Back to map</button>
      {!preparation.valid ? <p role="alert">{preparation.errors.join(' ')}</p> : <>
        <dl className="preparation-dates"><div><dt>Start date</dt><dd>{preparation.payload.start_date}</dd></div><div><dt>End date</dt><dd>{preparation.payload.end_date}</dd></div></dl>
        <h2>Selected AOI · WGS84</h2>
        <button type="button" className="demo-button" disabled={busy} onClick={() => void copy('wkt')}>Copy WKT</button>
        <pre tabIndex={0} aria-label="Selected AOI WKT"><code>{preparation.payload.aoi_wkt}</code></pre>
        <h2>Analysis payload</h2>
        <button type="button" className="demo-button" disabled={busy} onClick={() => void copy('payload')}>Copy Payload</button>
        <pre tabIndex={0} aria-label="Displacement payload"><code>{JSON.stringify(preparation.payload, null, 2)}</code></pre>
        {!job && autoStartRequest === 0 && <button type="button" className="investigate-button" disabled={busy} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Start displacement processing'}</button>}
        {!job && autoStartRequest > 0 && <p role="status" aria-live="polite">{busy ? 'Submitting displacement job…' : 'Preparing displacement job…'}</p>}
        {job && <section className="displacement-job-status" aria-live="polite">
          <h2>Processing status</h2>
          <p><b>Status:</b> {job.state}</p><p><b>Job ID:</b> {job.id}</p>
          <p><b>Stage:</b> {job.stage}</p><p><b>Submitted:</b> {new Date(job.created_at).toLocaleString()} · {elapsed(job.created_at)}</p>
          {job.github_run_url && <p><a href={job.github_run_url} target="_blank" rel="noreferrer">Open GitHub Actions run</a></p>}
          {job.error_message && <p role="alert">{job.error_message}</p>}
          {job.state === 'succeeded' && <><p>Scientific workflow completed and reported validated per-product screening outputs.</p>
            {job.result_summary && <pre tabIndex={0} aria-label="Validated output summary"><code>{JSON.stringify(job.result_summary, null, 2)}</code></pre>}
            {job.artifact_url && <p><a href={job.artifact_url} target="_blank" rel="noreferrer">Open validated outputs</a></p>}</>}
        </section>}
        {jobError && <p role="alert">{jobError}</p>}
      </>}
      <p role="status" aria-live="polite">{feedback}</p>
    </section>
  </main>;
}
