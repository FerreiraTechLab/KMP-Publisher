const path = require("node:path");

function resolveProposalPath(record = {}) {
  if (typeof record.proposalPath === "string" && record.proposalPath.trim()) {
    return record.proposalPath;
  }
  if (typeof record.packagePath === "string" && record.packagePath.trim()) {
    return path.dirname(path.dirname(record.packagePath));
  }
  return null;
}

module.exports = {resolveProposalPath};
