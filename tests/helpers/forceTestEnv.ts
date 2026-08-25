/**
 * Task #4544 — import this FIRST (before any server module) in suites meant
 * to be bare-`tsx`-runnable. ESM evaluates imports in declaration order, so a
 * plain `process.env.NODE_ENV = ...` statement in the test file body runs
 * AFTER every hoisted server import — too late for modules that read
 * NODE_ENV at load (e.g. the pg pool's idleTimeoutMillis=0 test-mode config,
 * without which idle DB sockets keep a bare run alive forever after all
 * assertions pass). The batched test runner already exports NODE_ENV=test;
 * this only covers bare runs.
 */
process.env.NODE_ENV = process.env.NODE_ENV || "test";

export {};
