#!/usr/bin/env python3
"""Generate the HomeCloud user-installation artifacts.

Produces exactly what the operator runbooks currently create by hand:
runtime.env with fresh secrets, host-disks inventory, startup gates,
volume markers, directory tree with service ownership and a self-signed
TLS certificate. Fail-closed: existing installation artifacts are refused before writes.
A failed apply may leave partial artifacts; automatic resume is forbidden.

Modes:
  plan  — print the artifact map as JSON with secret values redacted;
  apply — write artifacts with exact modes/owners and create TLS via openssl.
"""
import argparse
import importlib.util
import platform
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import subprocess
import sys

FORMAT = 'homecloud-user-generate-v1'
PROJECT = re.compile(r'[a-z][a-z0-9-]{1,30}\Z')
FORBIDDEN_PROJECTS = {'homecloud-preview', 'homecloud', 'docker', 'test'}
HOST = re.compile(r'[a-z0-9.-]{1,253}\Z')
IPV4 = re.compile(r'(?:\d{1,3}\.){3}\d{1,3}\Z')
HEX_SECRET = 32
CHANNELS = ('release', 'test')
RELEASE_PUBLIC_KEY_PATH = Path(__file__).with_name('release-public.b64')
ETC = '/etc/homecloud'
UPDATE_BASE = '/var/lib/homecloud-update'
WORKER_TARGET = '/usr/local/sbin/homecloud-user-update'
SYSTEMD_TARGET = '/etc/systemd/system'
SYSTEMD_UNITS = ('homecloud-user-update.path', 'homecloud-user-update.service',
                 'homecloud-user-update-archive.service', 'homecloud-user-update-archive.timer')
# Те же репозитории, что REPOSITORIES в backend/src/updates/updates.service.ts.
UPDATE_REPOSITORIES = ('sv3t0v1k/homecloud', 'sv3t0v1k/https---github.com-sv3t0v1k-homecloud')
ENV_KEYS = (
    'COMPOSE_PROJECT_NAME', 'DB_PASSWORD', 'JWT_SECRET', 'JWT_REFRESH_SECRET',
    'REDIS_PASSWORD', 'PUBLIC_HOST', 'PUBLIC_BIND_IP', 'PUBLIC_HTTP_PORT',
    'PUBLIC_HTTPS_PORT', 'PUBLIC_ORIGIN', 'SSD_DB_DIR', 'HDD_STORAGE_DIR',
    'TLS_CERT_DIR', 'ACME_WEBROOT_DIR', 'RELEASE_BACKEND_IMAGE',
    'RELEASE_FRONTEND_IMAGE', 'INGRESS_SUBNET', 'INGRESS_PROXY_IP',
    'BACKEND_PROXY_SUBNET', 'FRONTEND_PROXY_IP',
    'UPDATE_CHANNEL', 'UPDATE_RELEASE_PUBLIC_KEY', 'UPDATE_INSTALL_BRIDGE_ENABLED',
)


class Refusal(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def load_release_public_key():
    """Ключ подписи релизов из репозитория; без него установка не доверяет обновлениям."""
    try:
        text = RELEASE_PUBLIC_KEY_PATH.read_text().strip()
    except OSError:
        raise Refusal('не найден deploy/user/release-public.b64 — ключ подписи релизов')
    require(re.fullmatch(r'[A-Za-z0-9+/=]+\Z', text) is not None,
            'release-public.b64: неверный формат base64')
    return text


def repo_file(*parts):
    """Текстовое содержимое файла рядом с generate.py (worker, systemd units)."""
    path = Path(__file__).with_name(parts[0])
    for part in parts[1:]:
        path = path / part
    try:
        return path.read_text(encoding='utf-8')
    except OSError:
        raise Refusal('не найден файл репозитория: ' + str(path))


def canonical_dir(value, label):
    require(isinstance(value, str) and value.startswith('/'), label + ': нужен абсолютный путь')
    require('\0' not in value and ' ' not in value, label + ': пробелы и NUL не поддерживаются')
    pure = PurePosixPath(value)
    require(str(pure) == value and '..' not in pure.parts, label + ': путь должен быть каноническим')
    require(len(value) > 1 and not value.endswith('/'), label + ': не trailing slash')
    return value


def validate_answers(answers):
    require(isinstance(answers, dict), 'answers: ожидается объект')
    name = answers.get('project_name')
    require(isinstance(name, str) and PROJECT.fullmatch(name), 'project_name: неверный формат')
    require(name not in FORBIDDEN_PROJECTS, 'project_name: зарезервированное имя')
    host = answers.get('public_host')
    require(isinstance(host, str) and HOST.fullmatch(host), 'public_host: неверный формат')
    channel = answers.get('update_channel')
    require(channel in CHANNELS, 'update_channel: release | test')
    bind_ip = answers.get('public_bind_ip')
    require(isinstance(bind_ip, str) and IPV4.fullmatch(bind_ip), 'public_bind_ip: ожидается IPv4')
    for key in ('http_port', 'https_port'):
        port = answers.get(key)
        require(type(port) is int and 1 <= port <= 65535, key + ': порт 1..65535')
    images = ('backend_image', 'frontend_image')
    for key in images:
        value = answers.get(key)
        require(isinstance(value, str) and value.strip() == value and value,
                key + ': образ обязателен')
        require(' ' not in value and '\t' not in value, key + ': пробелы запрещены')
    for key in ('postgres_uid', 'postgres_gid', 'backend_uid', 'backend_gid'):
        value = answers.get(key)
        require(type(value) is int and value > 0, key + ': положительное число')
    layout = answers.get('layout')
    require(isinstance(layout, dict), 'layout: ожидается объект')
    mode = layout.get('mode')
    require(mode in ('system-root', 'two-disk'), 'layout.mode: system-root | two-disk')
    require(answers['http_port'] != answers['https_port'], 'http_port и https_port обязаны различаться')
    canonical_dir(answers.get('project_root'), 'project_root')
    canonical_dir(answers.get('install_root'), 'install_root')
    canonical_dir(answers.get('tls_cert_dir'), 'tls_cert_dir')
    canonical_dir(answers.get('acme_webroot_dir'), 'acme_webroot_dir')
    canonical_dir(layout.get('db_dir'), 'layout.db_dir')
    canonical_dir(layout.get('storage_dir'), 'layout.storage_dir')
    for key in ('db_serial', 'storage_serial'):
        value = layout.get(key)
        require(isinstance(value, str) and value and value.strip() == value and
                not any(c.isspace() for c in value), 'layout.' + key + ': serial диска обязателен')
    require(layout['db_dir'] != layout['storage_dir'], 'db_dir и storage_dir обязаны различаться')
    storage_mount = layout.get('storage_mount')
    require(isinstance(storage_mount, str) and storage_mount.startswith('/'),
            'layout.storage_mount обязателен')
    require(layout['storage_dir'].startswith(storage_mount.rstrip('/') + '/'),
            'layout.storage_dir должен находиться внутри storage_mount')
    require(isinstance(layout.get('storage_uuid'), str) and layout['storage_uuid'],
            'layout.storage_uuid обязателен')
    if mode == 'two-disk':
        require(isinstance(layout.get('db_uuid'), str) and layout['db_uuid'], 'layout.db_uuid обязателен')
        db_mount = layout.get('db_mount')
        require(isinstance(db_mount, str) and db_mount.startswith('/'), 'layout.db_mount обязателен')
        require(layout['db_dir'].startswith(db_mount.rstrip('/') + '/'),
                'layout.db_dir должен находиться внутри db_mount')
    else:
        require(isinstance(layout.get('db_uuid'), str) and layout['db_uuid'],
                'layout.db_uuid обязателен (UUID корневого раздела)')
    return answers


def disk_inventory(answers):
    layout = answers['layout']
    db_dir = layout['db_dir']
    storage_dir = layout['storage_dir']
    inventory = {
        'ssd': {
            'mount': '/' if layout['mode'] == 'system-root' else layout['db_mount'],
            'uuid': layout.get('db_uuid') or 'ЗАПОЛНИТЬ-UUID-SSD',
            'serial': layout['db_serial'],
            'data': db_dir,
            'min_free_bytes': 10 * 1024 ** 3,
            'min_free_inodes': 10000,
        },
        'hdd': {
            'mount': layout['storage_mount'],
            'uuid': layout['storage_uuid'],
            'serial': layout['storage_serial'],
            'data': storage_dir,
            'min_free_bytes': 20 * 1024 ** 3,
            'min_free_inodes': 10000,
        },
        'postgres_uid': answers['postgres_uid'],
        'postgres_gid': answers['postgres_gid'],
    }
    if layout['mode'] == 'system-root':
        inventory['ssd']['identity_mode'] = 'system-root-lvm'
    return inventory


def gate_lines(answers):
    layout = answers['layout']
    db = 'db {uuid} {mount} {data} {uid} {gid}{extra}'.format(
        uuid=layout.get('db_uuid') or 'ROOT-UUID',
        mount='/' if layout['mode'] == 'system-root' else layout['db_mount'],
        data=layout['db_dir'],
        uid=answers['postgres_uid'], gid=answers['postgres_gid'],
        extra=' system-root-lvm' if layout['mode'] == 'system-root' else '')
    backend = 'backend {uuid} {mount} {data} {uid} {gid}'.format(
        uuid=layout['storage_uuid'],
        mount=layout['storage_mount'],
        data=layout['storage_dir'],
        uid=answers['backend_uid'], gid=answers['backend_gid'])
    return {'startup-db.gate': db + '\n',
            'startup-backend.gate': backend + '\n'}


def worker_config(answers):
    """Конфиг root-воркера обновлений (контракт deploy/user/update-worker.py)."""
    return json.dumps({
        'format': 'homecloud-user-update-worker-v1',
        'compose_project_dir': answers['project_root'],
        'runtime_env': ETC + '/runtime.env',
        'docker_config': ETC + '/docker',
        'public_host': answers['public_host'],
        'https_port': answers['https_port'],
        'repositories': list(UPDATE_REPOSITORIES),
    }, indent=2, sort_keys=True) + '\n'


def runtime_env(answers, generated, release_public_key):
    origin = 'https://{host}:{port}'.format(host=answers['public_host'],
                                            port=answers['https_port'])
    values = {
        'COMPOSE_PROJECT_NAME': answers['project_name'],
        'DB_PASSWORD': generated['DB_PASSWORD'],
        'JWT_SECRET': generated['JWT_SECRET'],
        'JWT_REFRESH_SECRET': generated['JWT_REFRESH_SECRET'],
        'REDIS_PASSWORD': generated['REDIS_PASSWORD'],
        'PUBLIC_HOST': answers['public_host'],
        'PUBLIC_BIND_IP': answers['public_bind_ip'],
        'PUBLIC_HTTP_PORT': str(answers['http_port']),
        'PUBLIC_HTTPS_PORT': str(answers['https_port']),
        'PUBLIC_ORIGIN': origin,
        'SSD_DB_DIR': answers['layout']['db_dir'],
        'HDD_STORAGE_DIR': answers['layout']['storage_dir'],
        'TLS_CERT_DIR': answers['tls_cert_dir'],
        'ACME_WEBROOT_DIR': answers['acme_webroot_dir'],
        'RELEASE_BACKEND_IMAGE': answers['backend_image'],
        'RELEASE_FRONTEND_IMAGE': answers['frontend_image'],
        'INGRESS_SUBNET': answers['ingress_subnet'],
        'INGRESS_PROXY_IP': answers['ingress_proxy_ip'],
        'BACKEND_PROXY_SUBNET': answers['backend_proxy_subnet'],
        'FRONTEND_PROXY_IP': answers['frontend_proxy_ip'],
        'UPDATE_CHANNEL': answers['update_channel'],
        'UPDATE_RELEASE_PUBLIC_KEY': release_public_key,
        # Fail-closed: bridge включает только docker-compose.production-updates.yml.
        'UPDATE_INSTALL_BRIDGE_ENABLED': 'false',
    }
    for key in ENV_KEYS:
        value = values[key]

        require(
            isinstance(value, str)
            and re.fullmatch(r'[A-Za-z0-9_./:@=+,-]+', value) is not None,
            'unsafe runtime.env value: ' + key,
        )

    return ''.join(key + '=' + values[key] + '\n' for key in ENV_KEYS)


def build(answers):
    """In-memory artifact map: {relative path: {content|tls, mode, owner}}."""
    answers = validate_answers(answers)
    root = PurePosixPath(answers['install_root'])
    generated = {key: secrets.token_hex(HEX_SECRET)
                 for key in ('DB_PASSWORD', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'REDIS_PASSWORD')}
    layout = answers['layout']
    db_dir = PurePosixPath(layout['db_dir'])
    storage_dir = PurePosixPath(layout['storage_dir'])
    pg = (answers['postgres_uid'], answers['postgres_gid'])
    be = (answers['backend_uid'], answers['backend_gid'])

    files = {}
    files[ETC + '/runtime.env'] = {
        'content': runtime_env(answers, generated, load_release_public_key()),
        'mode': 0o600, 'owner': (0, 0),
        'secret_keys': sorted(generated)}
    files[ETC + '/host-disks.json'] = {
        'content': json.dumps(disk_inventory(answers), indent=2, ensure_ascii=False) + '\n',
        'mode': 0o600, 'owner': (0, 0)}
    for name, content in gate_lines(answers).items():
        files[ETC + '/' + name] = {'content': content, 'mode': 0o644, 'owner': (0, 0)}
    files[ETC + '/release-public.b64'] = {
        'content': load_release_public_key() + '\n', 'mode': 0o644, 'owner': (0, 0)}
    files[ETC + '/update-worker.json'] = {
        'content': worker_config(answers), 'mode': 0o600, 'owner': (0, 0)}
    for unit in SYSTEMD_UNITS:
        files[SYSTEMD_TARGET + '/' + unit] = {
            'content': repo_file('systemd', unit), 'mode': 0o644, 'owner': (0, 0)}
    files[WORKER_TARGET] = {
        'content': repo_file('update-worker.py'), 'mode': 0o700, 'owner': (0, 0)}
    files[str(db_dir.parent / '.homecloud-db')] = {
        'content': 'homecloud-v1 db {uuid}\n'.format(uuid=layout.get('db_uuid') or 'ROOT-UUID'),
        'mode': 0o400, 'owner': pg}
    files[str(storage_dir.parent / '.homecloud-backend')] = {
        'content': 'homecloud-v1 backend {uuid}\n'.format(uuid=layout['storage_uuid']),
        'mode': 0o400, 'owner': be}

    dirs = {
        ETC: (0o700, (0, 0)),
        ETC + '/maintenance': (0o711, (0, 0)),
        ETC + '/docker': (0o700, (0, 0)),
        UPDATE_BASE: (0o750, (0, 0)),
        UPDATE_BASE + '/inbox': (0o770, (0, answers['backend_gid'])),
        UPDATE_BASE + '/status': (0o750, (0, answers['backend_gid'])),
        str(root / '.runtime'): (0o700, (0, 0)),
        str(db_dir): (0o700, pg),
        str(storage_dir): (0o700, be),
        str(storage_dir / '.tmp'): (0o700, be),
        answers['tls_cert_dir']: (0o700, (0, 0)),
        str(Path(answers['tls_cert_dir']) / 'current'): (0o700, (0, 0)),
        answers['acme_webroot_dir']: (0o755, (0, 0)),
    }
    tls = {
        'cert': str(Path(answers['tls_cert_dir']) / 'current' / 'fullchain.pem'),
        'key': str(Path(answers['tls_cert_dir']) / 'current' / 'privkey.pem'),
        'cn': answers['public_host'],
        'san_ip': [answers['public_bind_ip']],
        'san_dns': [] if IPV4.fullmatch(answers['public_host']) else [answers['public_host']],
    }
    return {'format': FORMAT, 'files': files, 'dirs': dirs, 'tls': tls,
            'generated_keys': sorted(generated)}


def redact_plan(plan):
    files = {}
    for path, item in plan['files'].items():
        entry = dict(item)
        if entry.pop('secret_keys', None):
            # Секреты — значения строк; в plan заменяются маркером.
            lines = []
            for line in entry['content'].splitlines(keepends=True):
                name, _, _ = line.partition('=')
                if name in plan['generated_keys']:
                    lines.append(name + '=<generated>\n')
                else:
                    lines.append(line)
            entry['content'] = ''.join(lines)
        files[path] = entry
    return {'format': plan['format'], 'files': files,
            'dirs': {path: [oct(mode), list(owner)] for path, (mode, owner) in plan['dirs'].items()},
            'tls': {key: (value if key != 'key' else value) for key, value in plan['tls'].items()
                    if key in ('cert', 'cn', 'san_ip', 'san_dns')},
            'generated_keys': plan['generated_keys']}


def load_release_bootstrap():
    path = Path(__file__).resolve().with_name('bootstrap.py')

    spec = importlib.util.spec_from_file_location(
        'homecloud_release_bootstrap', path)

    require(spec is not None and spec.loader is not None,
            'cannot load release verifier')

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    return module


def assert_install_identity(answers, repository_root):
    """Bind the installation to its actual checkout and signed images."""
    root = Path(repository_root).resolve(strict=True)

    require(answers.get('project_root') == str(root),
            'project_root must match the actual installer checkout')

    channel = answers.get('update_channel')

    require(channel in CHANNELS, 'invalid installation channel')

    if channel == 'test':
        return

    bootstrap = load_release_bootstrap()

    try:
        evidence = bootstrap.verify_local_release(str(root))
    except (bootstrap.Failure, OSError, ValueError,
            subprocess.SubprocessError) as error:
        raise Refusal('signed RELEASE evidence rejected: ' + str(error))

    for role in ('backend', 'frontend'):
        require(
            answers.get(role + '_image') == evidence['images'][role],
            'RELEASE image differs from signed lock: ' + role,
        )


def load_host_preflight():
    """Reuse the existing native Linux disk qualification contract."""
    path = Path(__file__).resolve().parents[1] / 'linux/preflight.py'
    spec = importlib.util.spec_from_file_location(
        'homecloud_host_preflight', path)
    require(spec is not None and spec.loader is not None,
            'cannot load host preflight')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_trusted_parents(plan):
    """Existing parents must not allow unprivileged path replacement."""
    targets = (
        set(plan['dirs'])
        | set(plan['files'])
        | {plan['tls']['cert'], plan['tls']['key']}
    )
    checked = set()

    for value in sorted(targets):
        for parent in reversed(Path(value).parents):
            if parent in checked:
                continue
            checked.add(parent)

            try:
                info = parent.lstat()
            except FileNotFoundError:
                continue

            require(stat.S_ISDIR(info.st_mode),
                    'unsafe install parent: ' + str(parent))
            require(info.st_uid == 0 and not info.st_mode & 0o022,
                    'untrusted install parent: ' + str(parent))

            require(not os.listxattr(parent, follow_symlinks=False),
                    'extended attributes on install parent: ' + str(parent))


def check_host_disks(inventory, preflight):
    """Qualify disks and future data paths without creating directories."""
    ssd = inventory['ssd']
    hdd = inventory['hdd']

    db = Path(ssd['data'])
    storage = Path(hdd['data'])

    require(db != storage and db not in storage.parents
            and storage not in db.parents,
            'data directories overlap')

    require(ssd['uuid'] != hdd['uuid'],
            'SSD/HDD must have different filesystem UUIDs')

    ssd_device = preflight.check_disk(ssd, 'db')
    hdd_device = preflight.check_disk(hdd, 'backend')

    require(ssd_device != hdd_device,
            'SSD/HDD must be different physical disks')

    for disk in (ssd, hdd):
        data = Path(disk['data'])
        mount = Path(disk['mount'])

        require(data.is_absolute() and mount.is_absolute(),
                'data and mount paths must be absolute')
        require(str(data) == disk['data']
                and str(mount) == disk['mount']
                and '..' not in data.parts
                and '..' not in mount.parts,
                'non-canonical disk path')
        require(mount in data.parents,
                'data directory must be below mountpoint')

        # Data directory does not exist yet.
        # Resolve its nearest existing ancestor.
        parent = data.parent

        while True:
            try:
                info = parent.lstat()
                require(stat.S_ISDIR(info.st_mode),
                        'invalid data ancestor: ' + str(parent))
                break
            except FileNotFoundError:
                require(parent != parent.parent,
                        'no existing data ancestor')
                parent = parent.parent

        records = json.loads(preflight.host_findmnt(
            '--json', '--target', str(parent),
            '--output', 'TARGET,UUID'))['filesystems']

        require(len(records) == 1,
                'ambiguous data ancestor mount')

        record = records[0]

        require(record['target'] == disk['mount']
                and record['uuid'] == disk['uuid'],
                'future data directory is on a different mount: '
                + str(data))


def assert_host_admission(answers, plan):
    """Read-only admission before any persistent artifact is created."""
    require(platform.system() == 'Linux'
            and platform.machine() == 'x86_64',
            'installation requires native Linux x86_64')

    assert_fresh_install(plan)
    check_trusted_parents(plan)

    preflight = load_host_preflight()

    try:
        check_host_disks(disk_inventory(answers), preflight)
    except (preflight.Refusal, OSError, ValueError,
            KeyError, TypeError, subprocess.SubprocessError) as error:
        raise Refusal('host disk admission failed: ' + str(error))


def assert_fresh_install(plan):
    """Read-only admission: never overwrite an existing installation."""
    targets = (
        set(plan['dirs'])
        | set(plan['files'])
        | {plan['tls']['cert'], plan['tls']['key']}
    )

    for value in sorted(targets):
        path = Path(value)
        require(path.is_absolute(), 'install target must be absolute')
        require(str(path) == value and '..' not in path.parts,
                'install target must be canonical')

        for parent in reversed(path.parents):
            try:
                info = parent.lstat()
            except FileNotFoundError:
                continue

            require(stat.S_ISDIR(info.st_mode),
                    'unsafe install parent: ' + str(parent))

        try:
            path.lstat()
        except FileNotFoundError:
            continue

        raise Refusal(
            'existing installation artifact; refusing overwrite: '
            + str(path)
        )


def write_file(path, content, mode, owner):
    # Never truncate or replace an existing file, even after admission.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    descriptor = os.open(path, flags, mode)

    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        os.fchown(handle.fileno(), owner[0], owner[1])
        os.fchmod(handle.fileno(), mode)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def apply_plan(plan):
    created = []

    # Validate every managed target before the first persistent write.
    assert_fresh_install(plan)

    require(ETC in plan['dirs'], 'missing installation admission directory')

    try:
        # Atomic reservation. A second installer cannot acquire it.
        # Failure after this point deliberately requires manual recovery.
        mode, owner = plan['dirs'][ETC]
        os.mkdir(ETC, mode)
        os.chown(ETC, owner[0], owner[1])
        os.chmod(ETC, mode)
        created.append(ETC)

        for path, (mode, owner) in sorted(plan['dirs'].items()):
            if path == ETC:
                continue

            # Existing ancestors are not chmod/chown targets.
            Path(path).parent.mkdir(parents=True, exist_ok=True)

            # Never accept an existing managed directory.
            os.mkdir(path, mode)
            os.chown(path, owner[0], owner[1])
            os.chmod(path, mode)
            created.append(path)

        for path, item in plan['files'].items():
            parent = os.path.dirname(path)

            if parent and not os.path.isdir(parent):
                raise Refusal('parent directory missing: ' + parent)

            write_file(
                path,
                item['content'],
                item['mode'],
                item['owner'],
            )
            created.append(path)

    except OSError as error:
        raise Refusal('apply failed; manual review required: ' + str(error))

    return created


def create_tls(tls):
    for name in ('cert', 'key'):
        require(not os.path.lexists(tls[name]),
                'existing TLS artifact; refusing overwrite')
    san = ['IP:' + ip for ip in tls['san_ip']] + ['DNS:' + dns for dns in tls['san_dns']]
    require(bool(san), 'TLS: нужен хотя бы один SAN')
    command = ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
               '-days', '3650', '-subj', '/CN=' + tls['cn'],
               '-addext', 'subjectAltName=' + ','.join(san),
               '-out', tls['cert'], '-keyout', tls['key']]
    try:
        result = subprocess.run(command, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, timeout=60, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise Refusal('openssl unavailable: ' + str(error))
    if result.returncode != 0:
        raise Refusal('openssl refused: ' + result.stderr.decode('utf-8', 'replace')[:200])
    os.chmod(tls['key'], 0o600)
    os.chmod(tls['cert'], 0o644)


def main():
    # RELEASE has a closed file allowlist, including during imports.
    sys.dont_write_bytecode = True
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--answers', required=True, help='JSON answers file')
    parser.add_argument('--mode', choices=('plan', 'apply'), required=True)
    args = parser.parse_args()
    try:
        with open(args.answers, 'r', encoding='utf-8') as handle:
            answers = json.load(handle)
        plan = build(answers)
        if args.mode == 'plan':
            print(json.dumps(redact_plan(plan), indent=2, sort_keys=True))
        else:
            if os.geteuid() != 0:
                raise Refusal('apply требует root')
            assert_install_identity(
                answers, Path(__file__).resolve().parents[2])
            assert_host_admission(answers, plan)
            apply_plan(plan)
            create_tls(plan['tls'])
            print(json.dumps({'format': FORMAT, 'status': 'APPLIED',
                              'artifacts': len(plan['files']) + len(plan['dirs'])},
                             sort_keys=True))
    except (Refusal, ValueError, OSError) as error:
        print('STOP generate: ' + str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
