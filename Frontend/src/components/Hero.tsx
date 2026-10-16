import { LocationChip } from './LocationChip';

export function Hero() {
  return (
    <section className="hero-stage">
      <div className="hero-copy-block">
        <p className="hero-kicker">SATELLITE INSIGHTS FOR A SAFER TOMORROW</p>
        <h1><b>SAR</b>Guardian</h1>
        <p className="hero-subtitle">Natural Hazards. Clearer Answers.</p>
      </div>
      <LocationChip label="OCEAN" coordinates="+3.1028° S  +101.6869° E" icon="≋" className="chip-ocean" />
      <LocationChip label="HIMALAYAS" coordinates="+27.9981° N  +86.9250° E" icon="⌃" className="chip-himalayas" />
      <LocationChip label="FOREST" coordinates="+1.3521° N  +103.8198° E" icon="♣" className="chip-forest" />
    </section>
  );
}
