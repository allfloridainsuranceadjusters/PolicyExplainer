// backend/policyExplainer.db.js
import wixData from "wix-data";

const COLLECTION_ID = "PolicyExplainerRuns";

export async function writeTestRun() {
  const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const item = {
    title: `Run ${runId}`,     // REQUIRED
    runId,
    status: "TEST_OK",
    step: "DB_WRITE",
    email: "test@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await wixData.insert(COLLECTION_ID, item);
  return { runId: result.runId, _id: result._id };
}
