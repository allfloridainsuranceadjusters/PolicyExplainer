// ==============================
// Policy Explainer Page Code
// Full-file replacement (SAFE)
// ==============================

import { pingPolicyExplainer, testDbWrite } from "backend/policyExplainer.web";

$w.onReady(function () {
  console.log("✅ Policy Explainer page code loaded");

  // OPTIONAL: backend test button (safe to remove later)
  if ($w("#testDbBtn")) {
    $w("#testDbBtn").onClick(async () => {
      try {
        console.log("▶️ testDbBtn clicked");

        const pong = await pingPolicyExplainer();
        console.log("✅ Ping response:", pong);

        const dbRes = await testDbWrite();
        console.log("✅ testDbWrite result:", dbRes);
      } catch (err) {
        console.error("❌ testDbBtn error:", err);
      }
    });
  }
});
