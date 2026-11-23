'use strict';
// Runs the nodeunit-style test suites (module.exports = { setUp, tearDown, 'name': function (test) {...} })
// on the built-in node:test runner, so no external test framework is needed.
//
// Usage: node test/common/run_suites.js [suite files...]
// Without arguments, every .js file directly in test/ is run (same as nodeunit's default for a folder).
// Filter tests with node's --test-name-pattern, e.g. node --test-name-pattern="Happy Path" test/common/run_suites.js

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_TIMEOUT_MS = 60000;
const TEARDOWN_TIMEOUT_MS = 10000;
// node:test's own timeout is only a backstop; it must outlast our test + tearDown timeouts.
const NODE_TEST_TIMEOUT_MS = TEST_TIMEOUT_MS + TEARDOWN_TIMEOUT_MS + 5000;
const ASSERTIONS = [
  'ok', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual', 'strictEqual', 'notStrictEqual',
  'throws', 'doesNotThrow', 'ifError',
];

// Same contract as nodeunit's test object: failed assertions are recorded, not thrown,
// and reported together when test.done() is called.
function createTestObject(onDone) {
  const failures = [];
  let assertionCount = 0;
  let expectedCount;
  let finished = false;

  const test = {
    expect(count) {
      expectedCount = count;
    },
    done(err) {
      if (finished) return;
      finished = true;
      if (expectedCount !== undefined && expectedCount !== assertionCount) {
        failures.push(new Error(`Expected ${expectedCount} assertions, ${assertionCount} ran`));
      }
      if (err) failures.push(err);
      onDone(failures);
    },
  };
  for (const name of ASSERTIONS) {
    test[name] = function () {
      assertionCount++;
      try {
        assert[name].apply(null, arguments);
      } catch (e) {
        failures.push(e);
      }
    };
  }
  test.same = test.deepEqual;
  test.equals = test.equal;
  return test;
}

function toError(failures) {
  if (failures.length === 1) return failures[0];
  const message = failures.map((e, i) => `${i + 1}) ${e && e.message ? e.message : e}`).join('\n');
  return new AggregateError(failures, `${failures.length} assertions failed:\n${message}`);
}

// The runner enforces the test timeout itself (rather than relying only on node:test's) so that
// tearDown always runs, even for a hung test. Suites share state (e.g. `this.conn`) between tests,
// so after a timeout everything the stuck test does later (done(), setUp callback) must be ignored,
// otherwise it could tear down the next test's connection.
function runTest(suite, testFn) {
  return new Promise((resolve, reject) => {
    const context = {};
    let abandoned = false;
    let tornDown = false;
    let timer;

    const runTearDown = (failures) => {
      if (tornDown) return;
      tornDown = true;
      clearTimeout(timer);
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(tearDownTimer);
        return failures.length ? reject(toError(failures)) : resolve();
      };
      const tearDownTimer = setTimeout(() => {
        failures.push(new Error(`tearDown timed out after ${TEARDOWN_TIMEOUT_MS}ms`));
        finish();
      }, TEARDOWN_TIMEOUT_MS);
      if (!suite.tearDown) return finish();
      try {
        suite.tearDown.call(context, (err) => {
          if (err) failures.push(err);
          finish();
        });
      } catch (e) {
        failures.push(e);
        finish();
      }
    };

    const test = createTestObject((failures) => {
      if (abandoned) return; // late done() from a timed-out test
      runTearDown(failures);
    });

    timer = setTimeout(() => {
      abandoned = true;
      runTearDown([new Error(`Test timed out after ${TEST_TIMEOUT_MS}ms`)]);
    }, TEST_TIMEOUT_MS);

    const start = () => {
      if (abandoned) return; // late setUp callback from a timed-out test
      try {
        testFn.call(context, test);
      } catch (e) {
        test.done(e);
      }
    };
    if (!suite.setUp) return start();
    try {
      suite.setUp.call(context, (err) => (abandoned ? undefined : err ? test.done(err) : start()));
    } catch (e) {
      test.done(e);
    }
  });
}

function registerSuite(file) {
  const suite = require(file);
  describe(path.basename(file, '.js'), () => {
    for (const [name, value] of Object.entries(suite)) {
      if (name === 'setUp' || name === 'tearDown') continue;
      if (typeof value !== 'function') {
        throw new Error(`${file}: "${name}" is not a test function (nested groups are not supported)`);
      }
      it(name, { timeout: NODE_TEST_TIMEOUT_MS }, () => runTest(suite, value));
    }
  });
}

const testDir = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const files = args.length
  ? args.map((f) => path.resolve(f))
  : fs.readdirSync(testDir).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(testDir, f));

files.forEach(registerSuite);
