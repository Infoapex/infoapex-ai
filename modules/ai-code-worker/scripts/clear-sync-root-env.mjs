// Test-environment hygiene, not a production behavior change. src/git/sync-root.ts's
// detection of OneDrive/Dropbox/iCloud/Google Drive sync roots is a real safety check
// meant to inspect the ACTUAL host environment when ai-code-worker runs for real - it
// intentionally defaults to process.env (doctor.ts, fake-run.ts never override it).
// The test suite's own disposable tmpdir fixtures are never really inside a synced
// folder, but some CI Windows runners set a stray OneDrive-family env var whose value
// happens to be an ancestor of the OS temp directory, producing a false "under
// OneDrive" match that has nothing to do with the test being run (found via GitHub
// Actions windows-latest, 2026-09-02: every test that creates a repo under tmpdir()
// picked up a spurious sync-root WARN/BLOCK). Cleared once, here, for the whole test
// process via `node --import` - not something each test should have to defend against
// individually, and not a change to what sync-root.ts detects for a real user.
for (const name of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer", "ICLOUDDRIVE", "DROPBOX", "GOOGLE_DRIVE"]) {
  delete process.env[name];
}
