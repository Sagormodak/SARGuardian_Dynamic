import { useRef, useState } from 'react';
import { copyPreparation, type PreparedInvestigation } from '../engine/investigation';

export function DisplacementPreparation({ preparation, onBack }: { preparation: PreparedInvestigation; onBack: () => void }) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const copying = useRef(false);
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
  return <main className="nisar-results-main displacement-preparation">
    <section className="nisar-results-summary">
      <span className="result-kicker">DISPLACEMENT PREPARATION</span>
      <h1>Find Displacements</h1>
      <p>Your selected geometry and dates are ready for future backend integration. No displacement processing has run.</p>
      <button type="button" className="demo-button" onClick={onBack}>Back to map</button>
      {!preparation.valid ? <p role="alert">{preparation.errors.join(' ')}</p> : <>
        <dl className="preparation-dates"><div><dt>Start date</dt><dd>{preparation.payload.start_date}</dd></div><div><dt>End date</dt><dd>{preparation.payload.end_date}</dd></div></dl>
        <h2>Selected AOI · WGS84</h2>
        <button type="button" className="demo-button" disabled={busy} onClick={() => void copy('wkt')}>Copy WKT</button>
        <pre tabIndex={0} aria-label="Selected AOI WKT"><code>{preparation.payload.aoi_wkt}</code></pre>
        <h2>Analysis payload</h2>
        <button type="button" className="demo-button" disabled={busy} onClick={() => void copy('payload')}>Copy Payload</button>
        <pre tabIndex={0} aria-label="Displacement payload"><code>{JSON.stringify(preparation.payload, null, 2)}</code></pre>
      </>}
      <p role="status" aria-live="polite">{feedback}</p>
    </section>
  </main>;
}
