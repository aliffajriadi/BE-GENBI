import NodeCache from "node-cache";

// Hanya data yang bisa dibangun ulang dari MySQL (PRD bagian 12).
export const cache = new NodeCache({ stdTTL: 300, useClones: false });
