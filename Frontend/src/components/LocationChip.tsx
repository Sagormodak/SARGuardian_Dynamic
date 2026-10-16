type LocationChipProps = {
  label: string;
  coordinates: string;
  icon: string;
  className?: string;
};

export function LocationChip({ label, coordinates, icon, className = '' }: LocationChipProps) {
  return (
    <div className={`location-chip ${className}`}>
      <span className="location-icon" aria-hidden="true">{icon}</span>
      <span>
        <strong>{label}</strong>
        <small>{coordinates}</small>
      </span>
    </div>
  );
}
