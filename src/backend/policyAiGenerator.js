// backend/policyAiGenerator.js
// FULL-FILE REPLACEMENT
// Compatibility shim only. The runtime flow no longer uses this module.

export async function generateAiExplanation() {
  return {
    ok: false,
    error:
      "generateAiExplanation() is deprecated. The system now generates STRICT report JSON + PDF via policyReport.js.",
  };
}
