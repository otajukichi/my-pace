// Optional owner-created time-driven trigger. Legacy cadence: 15 minutes; the
// owner-approved daily/delta rollout requires one 5-minute trigger for the 30-minute
// save-to-ready goal, subject to measured quota/latency qualification. Create/remove it in the existing
// project's Triggers UI only after the coherent live acceptance bundle passes.
// Event fields cannot select methods, owners, stores, sources, limits or IDs.
// Keep this file server-only. Never route doGet/doPost/RPC to this handler.
var MYPACE_IMPORT_SCHEDULE = {
  sliceMs:60000, calls:750, steps:3, rangeBytes:1048576, scanIntervalMs:3600000, catchUp:true
};
function MyPaceImportScheduledTick(event) {
  var runtime=MyPaceFolderImport.createScheduledImportRuntime(myPaceOwnerGlobals_(),MYPACE_IMPORT_SCHEDULE);
  return myPaceOwnerReport_(runtime.tick(event));
}
