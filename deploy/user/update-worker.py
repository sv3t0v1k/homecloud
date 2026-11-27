#!/usr/bin/python3 -IS
"""HomeCloud user-channel update worker (release).

Root-owned host worker installed by deploy/user/install.sh to
/usr/local/sbin/homecloud-user-update. Trust model: the worker itself is a
bootstrap-installed anchor; every update is trusted ONLY through the Ed25519
release signature (deploy/user/release-public.b64, installed at
/etc/homecloud/release-public.b64). The backend container never dictates
bytes: it only drops a 64-hex manifest identity into the inbox, and this
worker re-downloads and re-verifies the release independently.

Modes:
  install  — consume one inbox request and apply the signed release;
  archive  — rotate a terminal receipt (INSTALLED / STOP) to restore NO_JOB.

Failure model: any refusal before the image reference switch is a retryable
STOP (PREPARATION). After the switch the worker rolls back to the previous
references; a failed rollback is MANUAL_RECOVERY_REQUIRED.
"""
import argparse
import base64
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
import ssl
from datetime import datetime, timezone, timedelta

CONFIG_PATH = Path('/etc/homecloud/update-worker.json')
PUBLIC_KEY_PATH = Path('/etc/homecloud/release-public.b64')
TOKEN_PATH = Path('/etc/homecloud/github-token')
BASE_DIR = Path('/var/lib/homecloud-update')
ROOT_UID = 0
ROOT_GID = 0
BACKEND_UID = 1001
GID = 65533
HASH = re.compile(r'[a-f0-9]{64}\Z')
SHA = re.compile(r'[a-f0-9]{40}\Z')
DIGEST = re.compile(r'sha256:[a-f0-9]{64}\Z')
TAG = re.compile(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-beta\.([1-9][0-9]*))?\Z')
BASE64 = re.compile(r'[A-Za-z0-9+/=]+\Z')
STATUS_FORMAT = 'homecloud-update-status-v1'
REQUEST_FORMAT = 'homecloud-update-request-v1'
STALE_MINUTES = 30
MAX_BODY = 2 * 1024 * 1024
ASSET_HOSTS = ('release-assets.githubusercontent.com', 'objects.githubusercontent.com')


USER_DEPLOYMENT_PATHS = ('docker-compose.yml', 'docker-compose.production.yml', 'docker-compose.production-updates.yml', 'deploy/user/install.sh', 'deploy/user/probe.py', 'deploy/user/generate.py', 'deploy/user/update-worker.py', 'deploy/user/bootstrap.py', 'deploy/user/bootstrap.sh', 'deploy/user/release-public.b64', 'deploy/user/systemd/homecloud-user-update.path', 'deploy/user/systemd/homecloud-user-update.service', 'deploy/user/systemd/homecloud-user-update-archive.service', 'deploy/user/systemd/homecloud-user-update-archive.timer', 'deploy/linux/preflight.py', 'deploy/linux/startup-gate.sh', 'deploy/ingress/19-validate-public-host.sh', 'deploy/ingress/default.conf.template', 'deploy/ingress/upgrade.conf')
INSTALLER_ONLY_PATHS = ('deploy/user/bootstrap.py', 'deploy/user/bootstrap.sh', 'deploy/user/generate.py', 'deploy/user/install.sh', 'deploy/user/probe.py')
RELEASE_EVIDENCE_DIR = '.homecloud-release'
RELEASE_COMPOSE_FILES = (
    'docker-compose.yml',
    'docker-compose.production.yml',
    'docker-compose.production-updates.yml',
)


class Refusal(Exception):
    """Pre-transaction refusal: no mutation happened, the attempt is retryable."""

    def __init__(self, reason, phase='PREPARATION'):
        super().__init__(reason)
        self.phase = phase


class RecoveryRequired(Exception):
    """Post-mutation failure: manual operator review is required."""


class Deps:
    """Injectable side effects; tests replace them, production uses real ones."""

    def run(self, args, **kwargs):
        return subprocess.run(args, capture_output=True, timeout=kwargs.get('timeout', 600),
                              env=kwargs.get('env'), check=False)

    def http_get(self, url, headers=None):
        request = urllib.request.Request(url, headers=headers or {})
        opener = urllib.request.build_opener(NoRedirect())
        try:
            with opener.open(request, timeout=15) as response:
                body = response.read(MAX_BODY + 1)
                return response.status, dict(response.headers), body
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read(MAX_BODY + 1)

    def now(self):
        return datetime.now(timezone.utc)

    def smoke_get(self, url, host_header):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        request = urllib.request.Request(url, headers={'Host': host_header})
        try:
            opener = urllib.request.build_opener(
                NoRedirect(),
                urllib.request.HTTPSHandler(context=context),
            )
            with opener.open(request, timeout=15) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def require(condition, reason, phase='PREPARATION'):
    if not condition:
        raise Refusal(reason, phase)


def fsync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_status(identity, status, phase, deps):
    value = {'format': STATUS_FORMAT, 'status': status, 'manifestSha256': identity,
             'phase': phase, 'updatedAt': deps.now().isoformat()}
    descriptor, tmp = tempfile.mkstemp(prefix='.status-', dir=str(BASE_DIR / 'status'))
    try:
        with os.fdopen(descriptor, 'w') as stream:
            os.fchmod(stream.fileno(), 0o640)
            os.fchown(stream.fileno(), ROOT_UID, GID)
            json.dump(value, stream, sort_keys=True, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, BASE_DIR / 'status' / 'current.json')
        fsync_dir(BASE_DIR / 'status')
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_json_root(path, mode, gid, limit=65536, links=(1,)):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID and
                info.st_gid == gid and stat.S_IMODE(info.st_mode) == mode and
                info.st_nlink in links and 0 < info.st_size <= limit, 'unsafe file: ' + str(path))
        value = json.loads(os.read(descriptor, limit + 1))
        require(type(value) is dict, 'invalid JSON object: ' + str(path))
        return value
    finally:
        os.close(descriptor)


def load_config():
    config = read_json_root(CONFIG_PATH, 0o600, ROOT_GID)
    require(config.get('format') == 'homecloud-user-update-worker-v1', 'invalid worker config')
    for key in ('compose_project_dir', 'runtime_env', 'docker_config'):
        value = config.get(key)
        require(type(value) is str and value.startswith('/') and '..' not in value,
                'invalid worker config: ' + key)
    require(config['docker_config'] == str(CONFIG_PATH.parent / 'docker'),
            'invalid worker Docker authority')
    host = config.get('public_host')
    require(type(host) is str and bool(host), 'invalid worker config: public_host')
    port = config.get('https_port')
    require(type(port) is int and 1 <= port <= 65535, 'invalid worker config: https_port')
    repositories = config.get('repositories')
    require(type(repositories) is list and repositories and
            all(type(item) is str and re.fullmatch(r'[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9_.-]*', item)
                for item in repositories), 'invalid worker config: repositories')
    token = ''
    if TOKEN_PATH.exists() and not TOKEN_PATH.is_symlink():
        info = TOKEN_PATH.stat()
        require(info.st_uid == ROOT_UID and stat.S_IMODE(info.st_mode) == 0o600,
                'unsafe github token file')
        token = TOKEN_PATH.read_text().strip()
        require(len(token) <= 256 and '\n' not in token, 'invalid github token file')
    config['github_token'] = token
    return config


def read_request():
    path = BASE_DIR / 'inbox' / 'request.json'
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
    )
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == BACKEND_UID and info.st_gid == GID and
                stat.S_IMODE(info.st_mode) == 0o600 and 1 <= info.st_nlink <= 2 and
                0 < info.st_size <= 512, 'unsafe inbox request')
        item = json.loads(os.read(descriptor, 513))
    finally:
        os.close(descriptor)
    require(type(item) is dict and set(item) == {'format', 'channel', 'manifestSha256'} and
            item['format'] == REQUEST_FORMAT and item['channel'] == 'release' and
            type(item['manifestSha256']) is str and HASH.fullmatch(item['manifestSha256']),
            'invalid release request')
    return item['manifestSha256']


def acquire_lock():
    descriptor = os.open(BASE_DIR / 'status' / 'install.lock',
                         os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID and
                stat.S_IMODE(info.st_mode) == 0o600, 'unsafe install lock')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def github_headers(config, accept):
    headers = {'Accept': accept, 'X-GitHub-Api-Version': '2022-11-28'}
    token = config.get('github_token', '')
    if token:
        headers['Authorization'] = 'Bearer ' + token
    return headers


def github_get(config, deps, url_or_path, accept='application/vnd.github+json'):
    urls = [url_or_path] if url_or_path.startswith('https://') else [
        'https://api.github.com/repos/' + repo + url_or_path for repo in config['repositories']]
    last_error = None
    for url in urls:
        try:
            status, headers, body = deps.http_get(url, github_headers(config, accept))
            if status == 302 and accept == 'application/octet-stream':
                location = headers.get('location') or headers.get('Location') or ''
                host = urllib.request.urlparse(location).hostname if location else ''
                require(urllib.request.urlparse(location).scheme == 'https' and host in ASSET_HOSTS,
                        'unexpected asset redirect')
                status, headers, body = deps.http_get(location, None)
            require(status == 200 and len(body) <= MAX_BODY, 'GitHub unavailable')
            return body
        except Exception as error:  # try the next repository name
            last_error = error
    raise Refusal('GitHub fetch failed: ' + str(last_error)[:120], 'FETCH_MANIFEST')


def canonical(value):
    """Byte-compatible with release.py identity(): sorted keys, tight separators."""
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def load_public_key():
    text = PUBLIC_KEY_PATH.read_text().strip()
    require(bool(BASE64.fullmatch(text)), 'invalid release public key')
    return base64.b64decode(text, validate=True)


def verify_signature(payload, signature_b64, public_der, deps):
    signature = base64.b64decode(signature_b64.strip(), validate=True)
    require(len(signature) == 64, 'invalid Ed25519 signature length')
    openssl = os.environ.get('HOMECLOUD_OPENSSL', 'openssl')
    with tempfile.TemporaryDirectory() as directory:
        key_path = Path(directory) / 'public.der'
        sig_path = Path(directory) / 'signature.bin'
        msg_path = Path(directory) / 'payload.bin'
        key_path.write_bytes(public_der)
        sig_path.write_bytes(signature)
        msg_path.write_bytes(payload)
        result = deps.run([openssl, 'pkeyutl', '-verify', '-pubin', '-inkey', str(key_path),
                           '-keyform', 'DER', '-rawin', '-in', str(msg_path),
                           '-sigfile', str(sig_path)])
    require(result.returncode == 0, 'release signature does not verify')


def parse_asset_url(config, item):
    """Return the asset API URL only for expected release asset names."""
    require(type(item) is dict and type(item.get('name')) is str and
            type(item.get('url')) is str, 'invalid release asset')
    for repo in config['repositories']:
        prefix = 'https://api.github.com/repos/' + repo + '/releases/assets/'
        if item['url'].startswith(prefix) and re.fullmatch(r'[0-9]+', item['url'][len(prefix):]):
            return item['url']
    raise Refusal('unexpected asset URL', 'FETCH_MANIFEST')


def iter_signed_locks(config, deps, public_der):
    """Yield (lock, lock_bytes) for every non-draft release whose lock asset
    pair verifies against the release key. A bad signature fails the whole
    scan closed — never skipped."""
    body = github_get(config, deps, '/releases?per_page=20')
    releases = json.loads(body)
    require(type(releases) is list, 'invalid releases response')
    for release in releases:
        if not type(release) is dict or release.get('draft') is not False:
            continue
        if type(release.get('tag_name')) is not str or not TAG.fullmatch(release['tag_name']):
            continue
        assets = release.get('assets')
        require(type(assets) is list, 'published release lacks signature assets')
        by_name = {}
        for item in assets:
            if type(item) is dict and item.get('name') in ('release-lock.json', 'release-lock.json.sig'):
                try:
                    by_name[item['name']] = parse_asset_url(config, item)
                except Refusal:
                    break
        require(set(by_name) == {'release-lock.json', 'release-lock.json.sig'},
                'published release lacks signature assets')
        lock_bytes = github_get(config, deps, by_name['release-lock.json'], 'application/octet-stream')
        sig_bytes = github_get(config, deps, by_name['release-lock.json.sig'], 'application/octet-stream')
        verify_signature(lock_bytes, sig_bytes.decode(), public_der, deps)
        lock = json.loads(lock_bytes)
        require(type(lock) is dict, 'invalid release lock')
        yield lock, lock_bytes


def discover_lock(identity, config, deps, public_der):
    """Find the release whose signed lock matches the requested identity."""
    for lock, lock_bytes in iter_signed_locks(config, deps, public_der):
        manifest = dict(lock)
        if manifest.pop('manifest_sha256', None) != identity or \
                hashlib.sha256(canonical(manifest).encode()).hexdigest() != identity:
            continue  # другая версия — ищем запрошенную дальше по списку
        validate_lock(lock)
        return lock, lock_bytes
    raise Refusal('no signed release matches the requested identity', 'FETCH_MANIFEST')


def discover_lock_by_images(backend_ref, frontend_ref, config, deps, public_der):
    """Find the signed release whose image references match the installed ones."""
    for lock, lock_bytes in iter_signed_locks(config, deps, public_der):
        images = lock.get('images')
        if type(images) is not dict:
            continue
        refs = {}
        for role in ('backend', 'frontend'):
            image = images.get(role)
            if type(image) is not dict:
                break
            refs[role] = str(image.get('repository')) + '@' + str(image.get('digest'))
        if len(refs) != 2:
            continue
        if refs['backend'] == backend_ref and refs['frontend'] == frontend_ref:
            validate_lock(lock)
            return lock, lock_bytes
    raise Refusal('no signed release matches the installed images', 'BOOTSTRAP')


def validate_lock(lock):
    require(
        type(lock) is dict
        and lock.get('format') == 'homecloud-ci-candidate-v1'
        and type(lock.get('tag')) is str
        and TAG.fullmatch(lock['tag'])
        and type(lock.get('commit')) is str
        and SHA.fullmatch(lock['commit'])
        and type(lock.get('tag_object')) is str
        and SHA.fullmatch(lock['tag_object'])
        and lock.get('deployment_status') == 'NOT_DEPLOYED',
        'invalid release lock shape',
    )

    repository = lock.get('repository')
    require(type(repository) is str and re.fullmatch(
        r'[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9_.-]*',
        repository), 'invalid release repository')

    ci = lock.get('ci')
    require(type(ci) is dict
            and ci.get('status') == 'success'
            and type(ci.get('run_id')) is str
            and ci['run_id'].isdigit()
            and type(ci.get('attempt')) is str
            and ci['attempt'].isdigit()
            and ci.get('url') == (
                'https://github.com/' + repository
                + '/actions/runs/' + ci['run_id']),
            'invalid release CI identity')

    qualification = lock.get('production_qualification')

    require(
        type(qualification) is dict
        and qualification.get('format') ==
            'homecloud-production-qualification-v2'
        and qualification.get('status') == 'PASS'
        and qualification.get('coverage') == 'COVERED'
        and qualification.get('qualification_profile') == 'release'
        and qualification.get('source_commit') == lock['commit']
        and type(qualification.get('ci')) is dict
        and qualification['ci'].get('run_id') == ci['run_id']
        and qualification['ci'].get('attempt') == ci['attempt'],
        'release qualification required',
    )

    migrations = lock.get('schema_migrations')

    require(
        type(migrations) is list and migrations
        and all(type(item) is str and
                re.fullmatch(r'[A-Za-z0-9]+', item)
                for item in migrations)
        and len(set(migrations)) == len(migrations),
        'invalid schema migration contract',
    )

    images = lock.get('images')

    require(type(images) is dict
            and set(images) == {'backend', 'frontend'},
            'invalid image pair')

    for role in ('backend', 'frontend'):
        image = images[role]

        require(
            type(image) is dict
            and image.get('repository') ==
                'ghcr.io/' + repository + '/' + role
            and type(image.get('digest')) is str
            and DIGEST.fullmatch(image['digest'])
            and image.get('revision') == lock['commit']
            and image.get('version') == lock['tag']
            and image.get('platform') == 'linux/amd64',
            'invalid image entry: ' + role,
        )

        proof = image.get('provenance_verification')

        require(
            type(proof) is dict
            and proof.get('index_digest') == image['digest']
            and proof.get('verified') ==
                'DIGEST_SUBJECT_VCS_DOCKERFILE_ARGS_BASE_MATERIALS',
            'invalid image provenance: ' + role,
        )

    body = dict(lock)
    identity = body.pop('manifest_sha256', None)

    require(
        identity == hashlib.sha256(
            canonical(body).encode()).hexdigest(),
        'invalid release manifest identity',
    )


def version_key(tag):
    match = TAG.fullmatch(tag)
    major, minor, patch, beta = match.groups()
    return (int(major), int(minor), int(patch), 1 if beta is None else 0, int(beta or 0))


def migration_hashes(lock):
    sources = lock.get('source_files')

    require(type(sources) is dict,
            'missing migration source contract')

    hashes = {
        name: value for name, value in sources.items()
        if type(name) is str
        and re.fullmatch(r'backend/src/migrations/[^/]+[.]ts', name)
    }

    require(
        len(hashes) == len(lock['schema_migrations'])
        and bool(hashes)
        and all(type(value) is str and HASH.fullmatch(value)
                for value in hashes.values()),
        'incomplete migration source hashes',
    )

    return hashes


def installed_lock_path():
    return BASE_DIR / 'status' / 'installed-lock.json'


def read_installed_lock():
    path = installed_lock_path()

    require(path.exists() or path.is_symlink(),
            'no installed release lock; updates are not bootstrapped')

    descriptor = os.open(
        path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)

    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())

        require(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == ROOT_UID
            and info.st_gid == GID
            and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == 0o640
            and 0 < info.st_size <= MAX_BODY,
            'unsafe installed lock',
        )

        payload = stream.read(MAX_BODY + 1)

    require(len(payload) <= MAX_BODY, 'installed lock too large')

    installed = json.loads(payload)
    validate_lock(installed)

    return installed, payload


def check_installed(lock):
    installed, payload = read_installed_lock()

    require(installed['commit'] != lock['commit'],
            'candidate is the installed version')

    require(version_key(lock['tag']) > version_key(installed['tag']),
            'candidate is not newer than installed')

    require(sorted(lock['schema_migrations'])
            == sorted(installed['schema_migrations']),
            'schema migrations differ; automatic update refused')

    require(migration_hashes(lock) == migration_hashes(installed),
            'migration contents differ; automatic update refused')

    return installed, payload


def verify_deployment_directory(path, evidence=False):
    info = path.lstat()
    mode = stat.S_IMODE(info.st_mode)

    require(
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == ROOT_UID
        and not mode & 0o7022
        and mode & 0o700 == 0o700,
        'unsafe deployment directory: ' + str(path),
    )

    if evidence:
        require(mode == 0o700, 'unsafe release evidence directory')

    if hasattr(os, 'listxattr'):
        require(not any(
            attr in ('system.posix_acl_access',
                     'system.posix_acl_default')
            for attr in os.listxattr(path, follow_symlinks=False)
        ), 'unsafe deployment directory ACL')


def verify_deployment_parents(root):
    require(root.is_absolute() and '..' not in root.parts,
            'invalid deployment root')

    for parent in reversed(root.parents):
        verify_deployment_directory(parent)


def read_deployment_file(path, mode):
    descriptor = os.open(
        path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)

    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())

        require(
            stat.S_ISREG(info.st_mode)
            and info.st_uid == ROOT_UID
            and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) == mode
            and info.st_size <= MAX_BODY,
            'unsafe deployment file: ' + str(path),
        )

        if hasattr(os, 'listxattr'):
            require(not any(
                attr in ('system.posix_acl_access',
                         'system.posix_acl_default')
                for attr in os.listxattr(path, follow_symlinks=False)
            ), 'unsafe deployment file ACL')

        data = stream.read(MAX_BODY + 1)

        require(len(data) <= MAX_BODY, 'deployment file too large')
        return data


def deployment_hashes(lock):
    sources = lock.get('source_files')

    require(type(sources) is dict, 'missing deployment source contract')

    result = {}

    for name in USER_DEPLOYMENT_PATHS:
        digest = sources.get(name)

        require(
            type(digest) is str and HASH.fullmatch(digest),
            'missing deployment hash: ' + name,
        )

        result[name] = digest

    return result


def verify_local_deployment(config, deps, public_der):
    """Verify the original installation proof without importing repo code."""
    try:
        root = Path(config['compose_project_dir'])

        require(str(root) == config['compose_project_dir'],
                'noncanonical deployment path')

        require(tuple(config.get(
            'compose_files', RELEASE_COMPOSE_FILES
        )) == RELEASE_COMPOSE_FILES, 'unexpected compose files')

        verify_deployment_parents(root)
        verify_deployment_directory(root)

        files = {
            name: 0o755 if name.endswith('.sh') else 0o644
            for name in USER_DEPLOYMENT_PATHS
        }

        lock_name = RELEASE_EVIDENCE_DIR + '/release-lock.json'
        sig_name = RELEASE_EVIDENCE_DIR + '/release-lock.json.sig'

        files[lock_name] = 0o600
        files[sig_name] = 0o600

        directories = {
            str(parent)
            for name in files
            for parent in Path(name).parents
            if str(parent) != '.'
        }

        found = {}
        found_dirs = set()
        pending = [root]

        while pending:
            directory = pending.pop()

            for target in directory.iterdir():
                name = str(target.relative_to(root))

                if name in files:
                    found[name] = read_deployment_file(
                        target, files[name])

                elif name in directories:
                    verify_deployment_directory(
                        target, evidence=name == RELEASE_EVIDENCE_DIR)

                    found_dirs.add(name)
                    pending.append(target)

                else:
                    raise Refusal(
                        'unexpected deployment path: ' + name)

        require(set(found) == set(files)
                and found_dirs == directories,
                'incomplete local deployment')

        payload = found[lock_name]

        verify_signature(
            payload,
            found[sig_name].decode('ascii'),
            public_der,
            deps,
        )

        lock = json.loads(payload)

        require(type(lock) is dict, 'invalid deployment lock')
        validate_lock(lock)

        identity = dict(lock)
        claimed = identity.pop('manifest_sha256', None)

        require(
            claimed == hashlib.sha256(
                canonical(identity).encode()).hexdigest(),
            'invalid deployment manifest identity',
        )

        for name, digest in deployment_hashes(lock).items():
            require(
                hashlib.sha256(found[name]).hexdigest() == digest,
                'local deployment hash mismatch: ' + name,
            )

        return lock, payload

    except (OSError, ValueError, TypeError, KeyError,
            AttributeError, subprocess.SubprocessError) as error:
        raise Refusal('local deployment verification failed: ' + str(error))


def check_deployment_compatibility(original, candidate):
    """This worker can update images, not the host deployment itself."""
    current = deployment_hashes(original)
    proposed = deployment_hashes(candidate)

    for name in USER_DEPLOYMENT_PATHS:
        if name not in INSTALLER_ONLY_PATHS:
            require(
                current[name] == proposed[name],
                'manual deployment update required: ' + name,
            )

    for role in ('backend', 'frontend'):
        require(
            original['images'][role]['repository']
            == candidate['images'][role]['repository'],
            'candidate image repository differs from installation',
        )


def verify_registry(lock, config, deps):
    for role in ('backend', 'frontend'):
        image = lock['images'][role]
        repository = image['repository'][len('ghcr.io/'):]
        scope = 'repository:' + repository + ':pull'
        status, _, grant_body = deps.http_get(
            'https://ghcr.io/token?service=ghcr.io&scope=' + urllib.request.quote(scope), None)
        require(status == 200, 'registry token unavailable')
        grant = json.loads(grant_body)
        require(type(grant) is dict and type(grant.get('token')) is str, 'invalid registry token')
        status, headers, _ = deps.http_get(
            'https://ghcr.io/v2/' + repository + '/manifests/' + image['digest'],
            {'Authorization': 'Bearer ' + grant['token'],
             'Accept': 'application/vnd.oci.image.index.v1+json, application.docker.distribution.manifest.list.v2+json'})
        digest = headers.get('docker-content-digest') or headers.get('Docker-Content-Digest') or ''
        require(status == 200 and digest == image['digest'], 'registry digest mismatch: ' + role)


def compose_env(config):
    return {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root'}


def compose_command(config, *args):
    base = ['docker', '--config', config['docker_config'],
            '--host', 'unix:///var/run/docker.sock',
            'compose', '--project-directory', config['compose_project_dir'],
            '--env-file', config['runtime_env']]
    for name in config.get('compose_files',
                           ['docker-compose.yml', 'docker-compose.production.yml',
                            'docker-compose.production-updates.yml']):
        base += ['-f', str(Path(config['compose_project_dir']) / name)]
    return base + list(args)


def compose(config, deps, *args):
    result = deps.run(compose_command(config, *args), env=compose_env(config), timeout=900)
    require(result.returncode == 0, 'compose failed: ' + ' '.join(args[:1]))


def env_path(config):
    return Path(config['runtime_env'])


def switch_images(config, lock):
    """Atomically point runtime.env at the candidate digests. Returns old refs."""
    path = env_path(config)
    original = path.read_bytes()
    require(len(original) <= 65536, 'runtime.env too large')
    lines = original.decode().splitlines(keepends=True)
    targets = {'RELEASE_BACKEND_IMAGE': lock['images']['backend']['repository'] + '@' + lock['images']['backend']['digest'],
               'RELEASE_FRONTEND_IMAGE': lock['images']['frontend']['repository'] + '@' + lock['images']['frontend']['digest']}
    previous = {}
    replaced = set()
    output = []
    for line in lines:
        key, sep, value = line.partition('=')
        if sep and key in targets:
            previous[key] = value.strip()
            output.append(key + '=' + targets[key] + '\n')
            replaced.add(key)
        else:
            output.append(line)
    require(replaced == set(targets), 'runtime.env lacks image references')
    require(all(DIGEST.fullmatch(item.partition('@')[2]) for item in previous.values()),
            'current image references are not digest-pinned')
    descriptor, tmp = tempfile.mkstemp(prefix='.runtime-env-', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            os.fchown(stream.fileno(), ROOT_UID, ROOT_GID)
            stream.write(''.join(output))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        fsync_dir(path.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return previous


def restore_images(config, previous):
    path = env_path(config)
    lines = path.read_bytes().decode().splitlines(keepends=True)
    output = []
    for line in lines:
        key, sep, _ = line.partition('=')
        if sep and key in previous:
            output.append(key + '=' + previous[key] + '\n')
        else:
            output.append(line)
    descriptor, tmp = tempfile.mkstemp(prefix='.runtime-env-', dir=str(path.parent))
    try:
        with os.fdopen(descriptor, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            os.fchown(stream.fileno(), ROOT_UID, ROOT_GID)
            stream.write(''.join(output))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        fsync_dir(path.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def smoke(config, deps, lock):
    verify_running_images(config, deps, lock)
    verify_database_migrations(config, deps, lock)

    values = read_runtime_values(config)

    bind = ipaddress.IPv4Address(
        values.get('PUBLIC_BIND_IP', ''))

    address = '127.0.0.1' if bind.is_unspecified else str(bind)

    status = deps.smoke_get(
        'https://' + address + ':'
        + str(config['https_port']) + '/',
        config['public_host'],
    )

    require(status == 200, 'smoke HTTP ' + str(status))


def write_installed_lock(lock_bytes):
    path = BASE_DIR / 'status' / 'installed-lock.json'
    descriptor, tmp = tempfile.mkstemp(prefix='.installed-lock-', dir=str(BASE_DIR / 'status'))
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o640)
            os.fchown(stream.fileno(), ROOT_UID, GID)
            stream.write(lock_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        fsync_dir(BASE_DIR / 'status')
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def journal_path():
    return BASE_DIR / 'status' / 'transaction.json'


def journal_exists():
    path = journal_path()
    return path.exists() or path.is_symlink()


def create_journal(identity, previous_payload):
    require(not journal_exists(), 'unfinished transaction exists')

    entry = {
        'format': 'homecloud-update-transaction-v1',
        'candidate': identity,
        'previous_lock': base64.b64encode(
            previous_payload).decode('ascii'),
    }

    path = journal_path()
    descriptor, temporary = tempfile.mkstemp(
        prefix='.transaction-', dir=str(path.parent))

    try:
        with os.fdopen(descriptor, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            os.fchown(stream.fileno(), ROOT_UID, ROOT_GID)
            json.dump(entry, stream, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())

        os.replace(temporary, path)
        fsync_dir(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_journal():
    entry = read_json_root(
        journal_path(), 0o600, ROOT_GID,
        limit=3 * MAX_BODY)

    require(
        set(entry) == {'format', 'candidate', 'previous_lock'}
        and entry['format'] == 'homecloud-update-transaction-v1'
        and type(entry['candidate']) is str
        and HASH.fullmatch(entry['candidate'])
        and type(entry['previous_lock']) is str,
        'invalid update transaction journal',
    )

    payload = base64.b64decode(
        entry['previous_lock'], validate=True)

    require(0 < len(payload) <= MAX_BODY,
            'invalid previous lock size')

    previous = json.loads(payload)
    validate_lock(previous)

    return entry['candidate'], previous, payload


def clear_journal():
    path = journal_path()
    os.unlink(path)
    fsync_dir(path.parent)


def rollback_transaction(config, deps):
    identity, previous, payload = read_journal()

    try:
        publish_status(identity, 'RUNNING', 'ROLLBACK', deps)

        original, _ = verify_local_deployment(
            config, deps, load_public_key())

        check_deployment_compatibility(original, previous)

        refs = {
            'RELEASE_' + role.upper() + '_IMAGE': reference
            for role, reference in zip(
                ('backend', 'frontend'), lock_image_refs(previous))
        }

        restore_images(config, refs)
        assert_runtime_identity(config, previous)

        compose(config, deps, 'up', '-d', '--no-build',
                '--wait', '--wait-timeout', '300')

        smoke(config, deps, previous)

        write_installed_lock(payload)

        publish_status(identity, 'STOP', 'ROLLBACK', deps)

    except Exception:
        publish_status(
            identity, 'MANUAL_RECOVERY_REQUIRED', 'ROLLBACK', deps)

        # Preserve journal for operator recovery.
        raise RecoveryRequired('rollback failed; journal retained')

    clear_journal()


def recover_transaction(config, deps):
    if not journal_exists():
        return False

    identity, previous, _ = read_journal()

    status_path = BASE_DIR / 'status' / 'current.json'

    receipt = (
        read_json_root(status_path, 0o640, GID, 4096)
        if status_path.exists() else {}
    )

    status = receipt.get('status')

    if status == 'MANUAL_RECOVERY_REQUIRED':
        # Do not repeatedly mutate a failed recovery.
        return True

    if receipt.get('manifestSha256') == identity:
        if status in ('INSTALLED', 'STOP'):
            installed, _ = read_installed_lock()

            expected = (
                identity if status == 'INSTALLED'
                else previous['manifest_sha256']
            )

            require(installed['manifest_sha256'] == expected,
                    'terminal receipt differs from installed lock')

            assert_runtime_identity(config, installed)
            clear_journal()
            return True

    # No durable terminal receipt: restore the prior release,
    # even if candidate containers had already started.
    rollback_transaction(config, deps)
    return True


def install(deps):
    require(os.geteuid() == 0, 'requires root')
    config = load_config()
    lock_fd = acquire_lock()
    try:
        if recover_transaction(config, deps):
            return

        status_path = BASE_DIR / 'status' / 'current.json'
        request_path = BASE_DIR / 'inbox' / 'request.json'
        if status_path.exists():
            # A saved receipt means the previous run never reached archival;
            # a fresh request is left untouched. A crashed run escalates.
            receipt = read_json_root(status_path, 0o640, GID, 4096)
            try:
                updated = datetime.fromisoformat(str(receipt.get('updatedAt')))
                stale = deps.now() - updated > timedelta(minutes=STALE_MINUTES)
            except (ValueError, TypeError):
                stale = True
            if receipt.get('status') in ('RUNNING', 'VALIDATION_REQUIRED') and stale:
                publish_status(str(receipt.get('manifestSha256')), 'MANUAL_RECOVERY_REQUIRED',
                               'STALE_RUN', deps)
            return
        if not request_path.exists():
            return
        identity = read_request()
        publish_status(identity, 'VALIDATION_REQUIRED', None, deps)
        os.unlink(request_path)
        fsync_dir(BASE_DIR / 'inbox')
        try:
            public_der = load_public_key()
            publish_status(identity, 'RUNNING', 'VERIFY_TRUST', deps)
            publish_status(identity, 'RUNNING', 'FETCH_MANIFEST', deps)
            lock, lock_bytes = discover_lock(identity, config, deps, public_der)
            installed, previous_payload = check_installed(lock)

            deployment_lock, _ = verify_local_deployment(
                config, deps, public_der)

            check_deployment_compatibility(deployment_lock, installed)
            check_deployment_compatibility(deployment_lock, lock)

            verify_running_images(config, deps, installed)
            verify_database_migrations(config, deps, installed)

            publish_status(identity, 'RUNNING', 'VERIFY_IMAGES', deps)
            verify_registry(lock, config, deps)

        except Exception as error:
            publish_status(identity, 'STOP', 'PREPARATION', deps)

            if isinstance(error, Refusal):
                raise

            raise Refusal('update preparation failed') from error

        # The previous identity must be durable BEFORE any mutation.
        create_journal(identity, previous_payload)

        try:
            publish_status(identity, 'RUNNING', 'WRITE_REFS', deps)
            switch_images(config, lock)

            compose(config, deps, 'pull', 'backend', 'frontend')

            publish_status(identity, 'RUNNING', 'START_SERVICES', deps)
            compose(config, deps, 'up', '-d', '--no-build',
                    '--wait', '--wait-timeout', '300')

            publish_status(identity, 'RUNNING', 'SMOKE', deps)
            smoke(config, deps, lock)

            write_installed_lock(lock_bytes)

        except Exception as error:
            rollback_transaction(config, deps)
            raise RecoveryRequired(
                'update failed; previous release restored') from error

        # Terminal receipt is the commit marker. A crash before it
        # triggers rollback; a crash after it only clears the journal.
        publish_status(identity, 'INSTALLED', 'COMPLETE', deps)
        clear_journal()
    finally:
        os.close(lock_fd)


def read_runtime_values(config):
    raw = read_deployment_file(env_path(config), 0o600)

    require(len(raw) <= 65536, 'runtime.env too large')

    values = {}

    for line in raw.decode().splitlines():
        key, sep, value = line.partition('=')

        if not sep or key.startswith('#'):
            continue

        require(key not in values,
                'duplicate runtime environment key: ' + key)

        values[key] = value.strip()

    return values


def read_image_refs(config):
    values = read_runtime_values(config)

    refs = tuple(
        values.get('RELEASE_' + role.upper() + '_IMAGE', '')
        for role in ('backend', 'frontend')
    )

    require(all(DIGEST.fullmatch(ref.partition('@')[2])
                for ref in refs),
            'installed image references are not digest-pinned')

    return refs


def lock_image_refs(lock):
    return tuple(
        lock['images'][role]['repository'] + '@'
        + lock['images'][role]['digest']
        for role in ('backend', 'frontend')
    )


def assert_runtime_identity(config, lock):
    require(read_image_refs(config) == lock_image_refs(lock),
            'runtime image references differ from installed lock')


def check_output(config, deps, args):
    result = deps.run(
        args, env=compose_env(config), timeout=60)

    require(result.returncode == 0,
            'runtime verification command failed')

    output = result.stdout or b''

    if isinstance(output, bytes):
        output = output.decode('utf-8')

    require(len(output) <= 65536,
            'runtime verification output too large')

    return output.strip()


def verify_running_images(config, deps, lock):
    assert_runtime_identity(config, lock)

    for role, reference in zip(
        ('backend', 'frontend'), lock_image_refs(lock)
    ):
        container = check_output(
            config, deps, compose_command(
                config, 'ps', '-q', role))

        require(re.fullmatch(r'[a-f0-9]{64}', container),
                'expected exactly one running container: ' + role)

        base = compose_command(config)
        docker = base[:base.index('compose')]

        actual = check_output(
            config, deps,
            docker + [
                'inspect', '--format',
                '{{.Config.Image}} {{.State.Status}} {{.State.Health.Status}}',
                container,
            ],
        )

        require(actual == reference + ' running healthy',
                'unexpected running image or health: ' + role)


def verify_database_migrations(config, deps, lock):
    command = (
        'psql -X -v ON_ERROR_STOP=1 -At '
        '-U "$POSTGRES_USER" -d "$POSTGRES_DB" '
        '-c "SELECT name FROM public.migrations ORDER BY name"'
    )

    output = check_output(
        config, deps, compose_command(
            config, 'exec', '-T', 'db',
            'sh', '-ec', command,
        ),
    )

    actual = output.splitlines()

    require(sorted(actual) == sorted(lock['schema_migrations']),
            'actual database migrations differ from release lock')


def bootstrap(deps):
    """First-time binding: locate the signed release whose images are EXACTLY
    the installed ones and persist it as installed-lock.json. Refuses when a
    lock already exists or no published signed release matches — updates stay
    unavailable rather than guessing the deployment evidence."""
    require(os.geteuid() == 0, 'requires root')
    config = load_config()
    lock_fd = acquire_lock()
    try:
        installed_path = BASE_DIR / 'status' / 'installed-lock.json'
        require(not installed_path.exists() and not installed_path.is_symlink(),
                'installed lock already exists')
        backend_ref, frontend_ref = read_image_refs(config)
        public_der = load_public_key()
        lock, lock_bytes = verify_local_deployment(
            config, deps, public_der)

        refs = tuple(
            lock['images'][role]['repository'] + '@'
            + lock['images'][role]['digest']
            for role in ('backend', 'frontend')
        )

        require(refs == (backend_ref, frontend_ref),
                'installed images differ from signed deployment')

        smoke(config, deps, lock)
        write_installed_lock(lock_bytes)
    finally:
        os.close(lock_fd)


def receipt_archive_name(receipt):
    identity = receipt['manifestSha256']
    suffix = hashlib.sha256(receipt['updatedAt'].encode()).hexdigest()[:16]
    return identity + '-' + suffix + '.json'


def create_marker(identity, archive_name):
    value = json.dumps({'manifestSha256': identity, 'archiveName': archive_name},
                       sort_keys=True).encode() + b'\n'
    status_dir = BASE_DIR / 'status'
    marker_path = status_dir / 'archiving.json'
    descriptor, temporary = tempfile.mkstemp(prefix='.archiving-', dir=status_dir)
    try:
        os.fchmod(descriptor, 0o640)
        os.fchown(descriptor, ROOT_UID, GID)
        remaining = memoryview(value)
        while remaining:
            written = os.write(descriptor, remaining)
            require(written > 0, 'archival marker write failed')
            remaining = remaining[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        require(not marker_path.exists(), 'archival marker already exists')
        os.replace(temporary, marker_path)
        fsync_dir(status_dir)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if os.path.exists(temporary):
            os.unlink(temporary)


def archive(deps):
    """Rotate a terminal receipt so the next self-service request is admitted.

    Marker protocol: archiving.json exists exactly while a receipt is mid-rotation;
    a crash leaves it behind and the next run resumes instead of guessing. While
    current.json is absent but the marker persists, the backend reports
    UNKNOWN_REQUIRES_REVIEW rather than NO_JOB.
    """
    require(os.geteuid() == 0, 'requires root')
    status_dir = BASE_DIR / 'status'
    status_path = status_dir / 'current.json'
    marker_path = status_dir / 'archiving.json'
    archive_dir = status_dir / 'archive'
    lock_fd = acquire_lock()
    try:
        if journal_exists():
            recover_transaction(load_config(), deps)
            return

        if status_path.exists():
            current = read_json_root(
                status_path, 0o640, GID, 4096, (1, 2))

            if current.get('status') in (
                'RUNNING', 'VALIDATION_REQUIRED'
            ):
                try:
                    updated = datetime.fromisoformat(
                        current['updatedAt'])
                    stale = (
                        deps.now() - updated
                        > timedelta(minutes=STALE_MINUTES)
                    )
                except (ValueError, TypeError, KeyError):
                    stale = True

                if stale:
                    publish_status(
                        current['manifestSha256'],
                        'MANUAL_RECOVERY_REQUIRED',
                        'STALE_RUN', deps)
                    return

        if not status_path.exists():
            if not marker_path.exists():
                return
            marker = read_json_root(marker_path, 0o640, GID, 4096)
            identity = marker.get('manifestSha256')
            archive_name = marker.get('archiveName')
            require(set(marker) == {'manifestSha256', 'archiveName'} and
                    type(identity) is str and HASH.fullmatch(identity) and
                    type(archive_name) is str and
                    re.fullmatch(r'[a-f0-9]{64}-[a-f0-9]{16}\.json', archive_name),
                    'invalid archival marker')
            archived = read_json_root(archive_dir / archive_name, 0o640, GID, 4096)
            require(archived.get('manifestSha256') == identity, 'archived receipt differs from marker')
            os.unlink(marker_path)
            fsync_dir(status_dir)
            return
        receipt = read_json_root(status_path, 0o640, GID, 4096, (1, 2))
        require(set(receipt) == {'format', 'status', 'manifestSha256', 'phase', 'updatedAt'} and
                receipt['format'] == STATUS_FORMAT and
                receipt['status'] in ('INSTALLED', 'STOP') and
                type(receipt['manifestSha256']) is str and HASH.fullmatch(receipt['manifestSha256']) and
                type(receipt['updatedAt']) is str and len(receipt['updatedAt']) <= 64,
                'receipt is not archivable')
        require(not (BASE_DIR / 'inbox' / 'request.json').exists(), 'pending request blocks archival')
        info = os.lstat(status_path)
        archive_name = receipt_archive_name(receipt)
        if marker_path.exists():
            marker = read_json_root(marker_path, 0o640, GID, 4096)
            require(marker == {'manifestSha256': receipt['manifestSha256'],
                               'archiveName': archive_name}, 'conflicting archival marker')
        else:
            create_marker(receipt['manifestSha256'], archive_name)
        if not archive_dir.exists():
            archive_dir.mkdir(mode=0o700)
            fsync_dir(status_dir)
        require(archive_dir.is_dir() and not archive_dir.is_symlink(), 'unsafe archive directory')
        destination = archive_dir / archive_name
        if destination.exists():
            archived = os.lstat(destination)
            require((archived.st_dev, archived.st_ino) == (info.st_dev, info.st_ino) and
                    info.st_nlink == 2, 'archive destination occupied')
        else:
            require(info.st_nlink == 1, 'unaccounted hard link on receipt')
            os.link(status_path, destination, follow_symlinks=False)
            fsync_dir(archive_dir)
        os.unlink(status_path)
        fsync_dir(status_dir)
        os.unlink(marker_path)
        fsync_dir(status_dir)
    finally:
        os.close(lock_fd)


def main(argv=None, deps=None):
    deps = deps or Deps()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('install', 'archive', 'bootstrap'))
    args = parser.parse_args(argv)
    if args.mode == 'install':
        install(deps)
    elif args.mode == 'bootstrap':
        bootstrap(deps)
    else:
        archive(deps)


if __name__ == '__main__':
    try:
        main()
    except RecoveryRequired:
        sys.exit('STOP: update needs manual operator review')
    except Exception:
        sys.exit('STOP: user update worker refused; see status receipt')
