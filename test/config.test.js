const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadDotEnv } = require('../src/config');

function withTempEnvFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envtest-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withoutLoadEnvFile(fn) {
  const original = process.loadEnvFile;
  delete process.loadEnvFile; // simulate Node < 20.12
  try {
    return fn();
  } finally {
    if (original) process.loadEnvFile = original;
  }
}

for (const mode of ['native process.loadEnvFile', 'dotenv fallback']) {
  test(`loadDotEnv (${mode}) loads .env without overriding variables already set`, () => {
    const run = () =>
      withTempEnvFile('ENVTEST_NEW=from-file\nENVTEST_EXISTING=from-file\n', (file) => {
        process.env.ENVTEST_EXISTING = 'from-environment';
        delete process.env.ENVTEST_NEW;
        try {
          loadDotEnv(file);
          assert.equal(process.env.ENVTEST_NEW, 'from-file');
          assert.equal(process.env.ENVTEST_EXISTING, 'from-environment');
        } finally {
          delete process.env.ENVTEST_NEW;
          delete process.env.ENVTEST_EXISTING;
        }
      });
    if (mode === 'dotenv fallback') withoutLoadEnvFile(run);
    else if (typeof process.loadEnvFile === 'function') run();
  });

  test(`loadDotEnv (${mode}) ignores a missing .env`, () => {
    const run = () => assert.doesNotThrow(() => loadDotEnv(path.join(os.tmpdir(), 'does-not-exist', '.env')));
    if (mode === 'dotenv fallback') withoutLoadEnvFile(run);
    else run();
  });
}
