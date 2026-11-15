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
  assert.equal(checkout.with.repository, '${{ github.repository }}');
  assert.equal(checkout.with.ref, '${{ github.event.pull_request.head.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);

  const verify = named('Verify exact checkout before candidate code');

  assert.ok(verify);
  assert.equal(verify.env.EXPECTED_SOURCE_SHA, '${{ github.event.pull_request.head.sha }}');
  assert.match(verify.run, /git rev-parse HEAD.*EXPECTED_SOURCE_SHA/);
  assert.equal(steps.indexOf(verify), steps.indexOf(checkout) + 1);

  const bootstrap = steps.find(
    step => step.run === 'python3 scripts/ci/install-npm.py'
  );

  assert.ok(bootstrap);
  assert.ok(steps.indexOf(verify) < steps.indexOf(bootstrap));
  assert.doesNotMatch(runs, /minimize-runner\.py/);

  const source = steps.find(step => step.id === 'source');
  assert.equal(source.env.EXPECTED_SOURCE_SHA, '${{ github.event.pull_request.head.sha }}');
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

  const exactImage = '${{ steps.image.outputs.image_id }}';

  assert.deepEqual(recovery.env, {
    HOMECLOUD_E2E_BACKEND_IMAGE: exactImage,
    HOMECLOUD_E2E_BACKEND_IMAGE_ID: exactImage,
  });

  assert.ok(commands.every(
    line => !line.includes('HOMECLOUD_E2E_BACKEND_IMAGE=')
  ));

  const binding = steps.find(step => step.id === 'image');

  assert.ok(binding);
  assert.equal(steps.indexOf(runtime) + 1, steps.indexOf(binding));
  assert.ok(steps.indexOf(binding) < steps.indexOf(native));
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
    'recovery-qualification',
  ]) {
    assert.ok(gate.needs.includes(name), name);
  }
});


test('native recovery binds the requested source to the PR event before checkout', () => {
  const guard = named('Verify trusted PR source before checkout');
  const checkout = steps.find(
    step => (step.uses || '').startsWith('actions/checkout@')
  );

  assert.ok(guard);
  assert.equal(steps[0], guard);
  assert.equal(steps[1], checkout);
  assert.equal(guard.shell, 'bash');

  assert.deepEqual(guard.env, {
    CALLER_EVENT_NAME: '${{ github.event_name }}',
    CALLER_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    CALLER_BASE_REPOSITORY: '${{ github.event.pull_request.base.repo.full_name }}',
    EXPECTED_REPOSITORY: '${{ github.repository }}',
    REQUESTED_SOURCE_SHA: '${{ inputs.source_sha }}',
  });

  assert.equal(guard.if, undefined);
  assert.equal(guard['continue-on-error'], undefined);

  const { spawnSync } = require('node:child_process');
  const sha = 'a'.repeat(40);
  const repo = 'fixture/repository';

  const valid = {
    CALLER_EVENT_NAME: 'pull_request',
    CALLER_HEAD_SHA: sha,
    CALLER_BASE_REPOSITORY: repo,
    EXPECTED_REPOSITORY: repo,
    REQUESTED_SOURCE_SHA: sha,
  };

  function execute(overrides) {
    const result = spawnSync('bash', ['-c', guard.run], {
      env: {
        ...process.env,
        ...valid,
        ...overrides,
      },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }

  assert.equal(execute({}).status, 0);

  const rejected = [
    ['different valid SHA', {
      REQUESTED_SOURCE_SHA: 'b'.repeat(40),
    }],
    ['missing caller HEAD', {
      CALLER_HEAD_SHA: '',
    }],
    ['malformed requested SHA', {
      REQUESTED_SOURCE_SHA: 'not-a-commit',
    }],
    ['malformed matching SHAs', {
      CALLER_HEAD_SHA: 'invalid',
      REQUESTED_SOURCE_SHA: 'invalid',
    }],
    ['matching SHA too short', {
      CALLER_HEAD_SHA: 'a'.repeat(39),
      REQUESTED_SOURCE_SHA: 'a'.repeat(39),
    }],
    ['matching SHA too long', {
      CALLER_HEAD_SHA: 'a'.repeat(41),
      REQUESTED_SOURCE_SHA: 'a'.repeat(41),
    }],
    ['matching SHA with non-hex character', {
      CALLER_HEAD_SHA: 'a'.repeat(39) + 'g',
      REQUESTED_SOURCE_SHA: 'a'.repeat(39) + 'g',
    }],
    ['matching SHA with newline', {
      CALLER_HEAD_SHA: 'a'.repeat(39) + '\n',
      REQUESTED_SOURCE_SHA: 'a'.repeat(39) + '\n',
    }],
    ['matching SHA with space', {
      CALLER_HEAD_SHA: 'a'.repeat(39) + ' ',
      REQUESTED_SOURCE_SHA: 'a'.repeat(39) + ' ',
    }],
    ['uppercase SHA', {
      CALLER_HEAD_SHA: sha.toUpperCase(),
      REQUESTED_SOURCE_SHA: sha.toUpperCase(),
    }],
    ['empty requested SHA', {
      REQUESTED_SOURCE_SHA: '',
    }],
    ['push event', {
      CALLER_EVENT_NAME: 'push',
    }],
    ['dispatch event', {
      CALLER_EVENT_NAME: 'workflow_dispatch',
    }],
    ['pull_request_target event', {
      CALLER_EVENT_NAME: 'pull_request_target',
    }],
    ['wrong repository', {
      CALLER_BASE_REPOSITORY: 'fixture/another-repository',
    }],
    ['missing repository', {
      EXPECTED_REPOSITORY: '',
      CALLER_BASE_REPOSITORY: '',
    }],
  ];

  for (const [name, overrides] of rejected) {
    const result = execute(overrides);
    assert.notEqual(result.status, 0, name);
    assert.doesNotMatch(result.stdout, /PASS:/, name);
  }
});


test('native recovery verifies exact backend context immediately before build', () => {
  const context = steps.find(step => step.id === 'context');
  const build = steps.find(step => step.id === 'offline');
  const source = steps.find(step => step.id === 'source');
  const builder = steps.find(
    step => (step.uses || '').startsWith('docker/setup-buildx-action@')
  );

  assert.ok(context);
  assert.ok(build);
  assert.ok(source);
  assert.ok(builder);

  assert.equal(context.name, 'Verify exact backend context before build');
  assert.equal(context.shell, 'bash');
  assert.equal(context.if, undefined);
  assert.equal(context['continue-on-error'], undefined);

  assert.equal(
    context.env.EXPECTED_SOURCE_SHA,
    '${{ github.event.pull_request.head.sha }}'
  );

  assert.equal(
    build.with.context,
    './backend'
  );

  assert.ok(steps.indexOf(source) < steps.indexOf(context));
  assert.ok(steps.indexOf(builder) < steps.indexOf(context));
  assert.equal(steps.indexOf(context) + 1, steps.indexOf(build));

  assert.match(context.run, /set -euo pipefail/);
  assert.match(context.run, /python3 -B scripts\/ci\/verify-recovery-context\.py/);
  assert.match(context.run, /--commit "\$EXPECTED_SOURCE_SHA"/);
  assert.match(context.run, /--output backend\.context\.binding\.json/);
  assert.match(context.run, /test -s backend\.context\.binding\.json \|\| exit 1/);

  const evidence = named('Verify recovery evidence files');
  assert.match(evidence.run, /backend\.context\.binding\.json/);

  const upload = steps.find(
    step => (step.uses || '').startsWith('actions/upload-artifact@')
  );

  assert.ok(
    upload.with.path.split('\n').includes('backend.context.binding.json')
  );

  assert.equal(upload.with['if-no-files-found'], 'error');

  const commands = read('ci-v2-fast.yml')
    .jobs['pr-fast-backend'].steps
    .map(step => step.run || '').join('\n');

  assert.match(commands, /python3 -B scripts\/ci\/test-recovery-context\.py/);
});


test('runtime OCI binding rejects substituted images', () => {
  const guard = steps.find(step => step.id === 'image');
  const runtime = steps.find(step => step.id === 'runtime');
  const identity = '${{ steps.image.outputs.image_id }}';

  assert.ok(guard);
  assert.equal(steps.indexOf(guard), steps.indexOf(runtime) + 1);
  assert.equal(guard.if, undefined);
  assert.equal(guard['continue-on-error'], undefined);

  assert.equal(
    guard.env.EXPECTED_SOURCE_SHA,
    '${{ github.event.pull_request.head.sha }}'
  );

  const smoke = named(
    'Backend production image native dependencies, without mounts or startup'
  );

  const native = named(
    'Real copy recovery and maintenance admission on the production image'
  );

  const architecture = named('Verify runtime image architecture');

  for (const step of [smoke, native, architecture]) {
    assert.equal(step.env.IMAGE, identity);
    assert.ok(steps.indexOf(guard) < steps.indexOf(step));
  }

  assert.match(smoke.run, /docker run --rm --pull=never/);
  assert.match(native.run, /docker run --rm --pull=never/);
  assert.match(architecture.run, /--format '\{\{\.Id\}\}'/);

  const { spawnSync } = require('node:child_process');
  const os = require('node:os');

  // Execute the real Python guard embedded in the workflow.
  const sections = guard.run.split("python3 - <<'PY'\n");
  assert.equal(sections.length, 2);

  const code = sections[1].split('\nPY')[0];

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hc-runtime-binding-fixture-')
  );

  try {
    const commit = 'a'.repeat(40);
    const imageId = 'sha256:' + '1'.repeat(64);
    const output = path.join(temporary, 'output.txt');
    const docker = path.join(temporary, 'docker');

    fs.writeFileSync(
      docker,
      '#!/bin/sh\n' +
      'printf "%s %s\\n" "$HC_FAKE_ID" "$HC_FAKE_PLATFORM"\n',
      { mode: 0o755 }
    );

    const proof = {
      role: 'backend',
      source_commit: commit,
      config_digest: imageId,
      binding: 'LOADED_EXACT_OCI_CONFIG_AND_FILESYSTEM',
    };

    function execute(changes = {}, envChanges = {}) {
      fs.writeFileSync(
        path.join(temporary, 'backend.loaded.binding.json'),
        JSON.stringify({ ...proof, ...changes })
      );

      fs.writeFileSync(output, '');

      const result = spawnSync('python3', ['-c', code], {
        cwd: temporary,
        env: {
          ...process.env,
          PATH: temporary + path.delimiter + process.env.PATH,
          EXPECTED_SOURCE_SHA: commit,
          GITHUB_OUTPUT: output,
          HC_FAKE_ID: imageId,
          HC_FAKE_PLATFORM: 'linux/amd64',
          ...envChanges,
        },
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.ifError(result.error);
      assert.equal(result.signal, null);

      return {
        status: result.status,
        output: fs.readFileSync(output, 'utf8'),
      };
    }

    const accepted = execute();

    assert.equal(accepted.status, 0);
    assert.equal(accepted.output, 'image_id=' + imageId + '\n');

    const rejected = [
      [{ role: 'frontend' }, {}],
      [{ source_commit: 'b'.repeat(40) }, {}],
      [{ binding: 'UNVERIFIED' }, {}],
      [{ config_digest: 'invalid' }, {}],
      [{ config_digest: 'sha256:' + 'A'.repeat(64) }, {}],
      [{}, { HC_FAKE_ID: 'sha256:' + '2'.repeat(64) }],
      [{}, { HC_FAKE_PLATFORM: 'linux/arm64' }],
    ];

    for (const [changes, envChanges] of rejected) {
      const result = execute(changes, envChanges);
      assert.notEqual(result.status, 0);
      assert.equal(result.output, '');
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});


test('Fast CI invokes Native Recovery directly and only for pull requests', () => {
  const fast = read('ci-v2-fast.yml');
  const call = fast.jobs['recovery-qualification'];
  const gate = fast.jobs['fast-integration-gate'];

  assert.deepEqual(call, {
    if: "github.event_name == 'pull_request'",
    uses: './.github/workflows/recovery-native.yml',
    with: {
      source_sha: '${{ github.event.pull_request.head.sha }}',
    },
    permissions: { contents: 'read' },
  });

  assert.deepEqual(new Set(gate.needs), new Set([
    'pr-fast-backend',
    'backend',
    'frontend',
    'configuration',
    'secrets',
    'recovery-qualification',
  ]));

  assert.equal(gate.name, 'ci-v2-fast-terminal');
  assert.equal(gate.if, 'always()');
  assert.equal(gate['continue-on-error'], undefined);

  const job = workflow.jobs['native-recovery'];

  assert.equal(job.uses, undefined);
  assert.equal(job['continue-on-error'], undefined);
});
