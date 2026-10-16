export const demoCase = {
  id: 'demo-case-landslide',
  title: 'Langtang landslide case study',
  summary: 'Demo case showing the intended site investigation flow and evidence-first product framing.',
  maturity: 'PROVISIONAL',
};

export const demoFinding = {
  measurement: { value: 9.2, unit: 'mm/day' },
  uncertainty: { value: 2.1, unit: 'mm/day' },
  observability: { geometry_status: 'usable' },
  persistence: { temporal: '0.88' },
  interpretation: 'The DEMO record shows an evidence-first investigation flow for a landslide case study, not a final scientific claim.',
  limitations: [
    'Representative fixture only.',
    'No operational NISAR product is connected in this demo stage.',
  ],
};
