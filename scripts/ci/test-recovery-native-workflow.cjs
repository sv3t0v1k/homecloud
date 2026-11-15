// Native recovery must not regress into full release qualification.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const yaml = require('../../backend/node_modules/js-yaml');

const root = path.resolve(__dirname, '../..');

const read = name => yaml.load(
  fs.readFileSync(
    path.join(root, '.github/workflows', name), 'utf8'
  )
);

const workflow = read('recovery-native.yml');
const job = workflow.jobs['native-recovery'];
const steps = job.steps;
const runs = steps.map(step => step.run || '').join('\n');
const named = name => steps.find(step => step.name === name);

test('recovery is read-only and callable-only', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
  assert.deepEqual(workflow.on.workflow_call.inputs, {
    source_sha: { type: 'string', required: true },
  });
  assert.deepEqual(Object.keys(workflow.jobs), ['native-recovery']);
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job.strategy, undefined);
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.uses, undefined);
  assert.ok(steps.every(step => !step['continue-on-error']));
  assert.ok(steps.every(step => !step.if));
  assert.ok(steps.every(step => !(step.uses || '').includes('docker/login-action')));
});

test('recovery checks exact source and builds offline AMD64 OCI', () => {
  const checkout = steps.find(
    step => (step.uses || '').startsWith('actions/checkout@')
  );
  assert.equal(checkout.with.ref, '${{ inputs.source_sha }}');
  assert.equal(checkout.with['persist-credentials'], false);

  const source = steps.find(step => step.id === 'source');
  assert.equal(source.env.EXPECTED_SOURCE_SHA, '${{ inputs.source_sha }}');
  assert.match(source.run, /git rev-parse HEAD.*EXPECTED_SOURCE_SHA/);

  const build = steps.find(step => step.id === 'offline');
  assert.ok(steps.indexOf(source) < steps.indexOf(build));
  assert.equal(build.with.platforms, 'linux/amd64');
  assert.equal(build.with.context, './backend');
  assert.equal(build.with.push, false);
  assert.equal(build.with.load, false);
  assert.match(build.with.outputs, /^type=oci,/);
  assert.equal(build.with.provenance, 'mode=max,version=v0.2');

  const builder = steps.find(
    step => (step.uses || '').startsWith('docker/setup-buildx-action@')
  );
  assert.match(builder.with['driver-opts'], /@sha256:[a-f0-9]{64}$/);
});

test('the exact retained image reaches real recovery tests', () => {
  const provenance = named('Verify offline OCI digest, source and attestation');
  assert.match(provenance.run, /scripts\/ci\/provenance\.py dry-run/);

  const runtime = steps.find(step => step.id === 'runtime');
  assert.match(runtime.run, /Linux\/x86_64/);
  assert.match(runtime.run, /oci-scan-binding\.py.*--loaded-inspect/);
  assert.match(runtime.run, /skopeo copy --override-os linux --override-arch amd64/);

  const native = named('Real copy recovery and maintenance admission on the production image');
  assert.match(native.run, /native-boundary-preflight\.cjs/);
  assert.match(native.run, /--strict/);
  assert.match(native.run, /test-maintenance-supervisor\.sh/);
  assert.match(native.run, /test-copy-recovery-e2e\.sh/);

  const recovery = named('Real Backup Restore in an isolated nested Docker daemon');
  const commands = recovery.run.split('\n').filter(
    line => line.includes('bash scripts/ci/run-restore-')
  );

  assert.equal(commands.length, 4);

  const exactImage =
    'HOMECLOUD_E2E_BACKEND_IMAGE="homecloud-ci-backend:${{ steps.source.outputs.commit }}"';

  assert.ok(commands.every(line => line.includes(exactImage)));
  assert.ok(commands.some(line => line.includes('--encrypted-only')));
  assert.ok(commands.some(line => line.includes('--historical-schema-only')));
  assert.ok(commands.some(line => line.includes('run-restore-fault-e2e-local.sh')));

  assert.ok(steps.indexOf(provenance) < steps.indexOf(runtime));
  assert.ok(steps.indexOf(runtime) < steps.indexOf(native));
  assert.ok(steps.indexOf(native) < steps.indexOf(recovery));
});

test('recovery does not run the entire release pipeline', () => {
  assert.doesNotMatch(runs, /scan-environment\.sh/);
  assert.doesNotMatch(runs, /qualify-stages\.sh/);
  assert.doesNotMatch(runs, /policy-coverage\.py/);
  assert.doesNotMatch(runs, /npm test -- --runInBand/);
  assert.doesNotMatch(runs, /docker push/);

  const upload = steps.find(
    step => (step.uses || '').startsWith('actions/upload-artifact@')
  );

  assert.equal(upload.with.name, 'native-recovery-evidence-${{ github.run_attempt }}');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.match(upload.with.path, /backend\.loaded\.binding\.json/);
  assert.doesNotMatch(upload.with.path, /\.oci\.tar/);
});

test('fast CI executes the new routing regression', () => {
  const fast = read('ci-v2-fast.yml');

  const commands = fast.jobs['pr-fast-backend'].steps
    .map(step => step.run || '').join('\n');

  assert.match(commands, /node --test scripts\/ci\/test-recovery-native-workflow\.cjs/);

  const gate = fast.jobs['fast-integration-gate'];

  assert.equal(gate.name, 'ci-v2-fast-terminal');
  assert.equal(gate.if, 'always()');

  for (const name of [
    'pr-fast-backend', 'backend',
    'frontend', 'configuration', 'secrets',
  ]) {
    assert.ok(gate.needs.includes(name), name);
  }
});
