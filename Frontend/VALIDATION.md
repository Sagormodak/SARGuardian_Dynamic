# Validation status

- Backend metadata API tests are in `SARGuardian-main/api_service/test_main.py`; they stub ASF responses and make no satellite-data downloads.
- The frontend's `Check NISAR archive` flow is wired to `VITE_SARGUARDIAN_API_URL`.
- The existing `Reference demo` still uses precomputed fixture data and is labeled as such in the UI.
- Full live NISAR retrieval, Harmony extraction, raster processing, and concurrent job queue are not implemented by this stage.
- Google login, Google Maps, public hosting configuration, and the live ASF network path still require deployment-time verification.
