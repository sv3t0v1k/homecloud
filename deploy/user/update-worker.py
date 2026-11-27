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
            with urllib.request.urlopen(request, timeout=15, context=context) as response:
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
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
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
        assets = release.get('assets')
        if not type(assets) is list:
            continue
        by_name = {}
        for item in assets:
            if type(item) is dict and item.get('name') in ('release-lock.json', 'release-lock.json.sig'):
                try:
                    by_name[item['name']] = parse_asset_url(config, item)
                except Refusal:
                    break
        if set(by_name) != {'release-lock.json', 'release-lock.json.sig'}:
            continue
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
    require(lock.get('format') == 'homecloud-ci-candidate-v1' and
            type(lock.get('tag')) is str and TAG.fullmatch(lock['tag']) and
            type(lock.get('commit')) is str and SHA.fullmatch(lock['commit']) and
            type(lock.get('schema_migrations')) is list and lock['schema_migrations'] and
            all(type(item) is str and re.fullmatch(r'[A-Za-z0-9]+', item) for item in lock['schema_migrations']),
            'invalid release lock shape')
    for role in ('backend', 'frontend'):
        image = lock.get('images', {}).get(role)
        require(type(image) is dict and type(image.get('repository')) is str and
                re.fullmatch(r'ghcr\.io/[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9_.-]*/' + role,
                             image['repository']) and
                type(image.get('digest')) is str and DIGEST.fullmatch(image['digest']) and
                image.get('revision') == lock['commit'] and image.get('version') == lock['tag'],
                'invalid image entry: ' + role)


def version_key(tag):
    match = TAG.fullmatch(tag)
    major, minor, patch, beta = match.groups()
    return (int(major), int(minor), int(patch), 0 if beta is None else 1, int(beta or 0))


def check_installed(lock):
    """The candidate must advance the installed version with identical migrations."""
    path = BASE_DIR / 'status' / 'installed-lock.json'
    if not path.exists() and not path.is_symlink():
        raise Refusal('no installed release lock; updates are not bootstrapped', 'PREPARATION')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == ROOT_UID and
                0 < info.st_size <= MAX_BODY, 'unsafe installed lock')
        installed = json.loads(os.read(descriptor, MAX_BODY + 1))
    finally:
        os.close(descriptor)
    require(type(installed) is dict, 'invalid installed lock')
    validate_lock(installed)
    require(installed['commit'] != lock['commit'], 'candidate is the installed version')
    require(version_key(lock['tag']) > version_key(installed['tag']),
            'candidate is not newer than installed')
    require(sorted(lock['schema_migrations']) == sorted(installed['schema_migrations']),
            'schema migrations differ; automatic update refused')


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


def smoke(config, deps):
    status = deps.smoke_get('https://127.0.0.1:' + str(config['https_port']) + '/',
                            config['public_host'])
    require(status < 500, 'smoke HTTP ' + str(status))


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


def install(deps):
    require(os.geteuid() == 0, 'requires root')
    config = load_config()
    lock_fd = acquire_lock()
    try:
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
            check_installed(lock)
            publish_status(identity, 'RUNNING', 'VERIFY_IMAGES', deps)
            verify_registry(lock, config, deps)
        except Refusal as error:
            publish_status(identity, 'STOP', 'PREPARATION', deps)
            raise
        # Point of no return: reference switch. Failures below roll back.
        publish_status(identity, 'RUNNING', 'WRITE_REFS', deps)
        previous = switch_images(config, lock)
        try:
            compose(config, deps, 'pull', 'backend', 'frontend')
            publish_status(identity, 'RUNNING', 'START_SERVICES', deps)
            compose(config, deps, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '300')
            publish_status(identity, 'RUNNING', 'SMOKE', deps)
            smoke(config, deps)
        except Exception:
            publish_status(identity, 'RUNNING', 'ROLLBACK', deps)
            try:
                restore_images(config, previous)
                compose(config, deps, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '300')
                smoke(config, deps)
            except Exception as rollback_error:
                publish_status(identity, 'MANUAL_RECOVERY_REQUIRED', 'ROLLBACK', deps)
                raise RecoveryRequired(str(rollback_error)[:120])
            publish_status(identity, 'STOP', 'ROLLBACK', deps)
            raise RecoveryRequired('rolled back after failed update')
        write_installed_lock(lock_bytes)
        publish_status(identity, 'INSTALLED', 'COMPLETE', deps)
    finally:
        os.close(lock_fd)


def read_image_refs(config):
    path = env_path(config)
    raw = path.read_bytes()
    require(len(raw) <= 65536, 'runtime.env too large')
    refs = {}
    for line in raw.decode().splitlines():
        key, sep, value = line.partition('=')
        if sep and key in ('RELEASE_BACKEND_IMAGE', 'RELEASE_FRONTEND_IMAGE'):
            refs[key] = value.strip()
    require(len(refs) == 2, 'runtime.env lacks image references')
    require(all(DIGEST.fullmatch(ref.partition('@')[2]) for ref in refs.values()),
            'installed image references are not digest-pinned')
    return refs['RELEASE_BACKEND_IMAGE'], refs['RELEASE_FRONTEND_IMAGE']


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
        _, lock_bytes = discover_lock_by_images(backend_ref, frontend_ref, config, deps, public_der)
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
    descriptor = os.open(BASE_DIR / 'status' / 'archiving.json',
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o640)
    try:
        os.fchmod(descriptor, 0o640)
        os.fchown(descriptor, ROOT_UID, GID)
        os.write(descriptor, value)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_dir(BASE_DIR / 'status')


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
