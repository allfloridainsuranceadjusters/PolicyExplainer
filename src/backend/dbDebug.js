// backend/dbDebug.js
import wixData from "wix-data";

export async function listCollections() {
  // Returns collection IDs available to site code
  const res = await wixData.listCollections();
  return res.collections.map(c => ({
    id: c.id,
    displayName: c.displayName
  }));
}
