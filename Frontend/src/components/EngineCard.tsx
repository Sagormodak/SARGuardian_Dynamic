import type { Engine } from '../data/engineData';
import type { CSSProperties } from 'react';

type EngineCardProps = {
  engine: Engine;
  onSelect: (engine: Engine) => void;
};

function EngineIcon({ type }: { type: Engine['icon'] }) {
  if (type === 'landslide') {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M5 37 21 12l8 12 5-7 9 20H5Z" />
        <path d="m18 31 7-7 5 5 5-4" />
        <path d="M8 39h34" />
      </svg>
    );
  }

  if (type === 'glacier') {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M5 37 18 15l8 11 6-9 11 20H5Z" />
        <path d="m18 15 4 7-4 4 6 5 2-5 5-4" />
      </svg>
    );
  }

  if (type === 'farming') {
    return (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M6 37c9-7 18-7 36 0" />
        <path d="M7 31c9-6 18-6 34 0M9 25c8-5 16-5 29 0" />
        <path d="M24 10v16M24 13c-5 0-8 3-9 7 5 0 8-2 9-7ZM24 17c5 0 8 3 9 7-5 0-8-2-9-7Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M5 18c6-6 12 6 19 0s12 6 19 0M5 27c6-6 12 6 19 0s12 6 19 0M5 36c6-6 12 6 19 0s12 6 19 0" />
    </svg>
  );
}

export function EngineCard({ engine, onSelect }: EngineCardProps) {
  return (
    <button
      className={`engine-card ${engine.active ? 'is-active' : 'is-muted'}`}
      type="button"
      onClick={() => onSelect(engine)}
      style={{ '--engine-image': `url("${engine.image}")` } as CSSProperties}
    >
      <span className="engine-wash" />
      <span className="engine-content">
        <span className="engine-icon"><EngineIcon type={engine.icon} /></span>
        <span className="engine-name">{engine.name}</span>
        <span className="engine-action">
          <span className={`engine-status ${engine.active ? 'active' : ''}`}>{engine.status}</span>
          <span className="arrow" aria-hidden="true">→</span>
        </span>
      </span>
    </button>
  );
}
