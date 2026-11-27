#!/usr/bin/env python3
"""Read-only environment probe for the user installer.

Collects facts the installer needs to propose safe defaults and to verify
the host before anything is written. No Docker API calls beyond version
inspection, no mounts, no writes. All commands run through an injectable
runner so the contract is testable without Linux tooling.
"""
import argparse
import json
import os
import platform
import re
import subprocess
import sys

FORMAT = 'homecloud-user-probe-v1'
NAME = re.compile(r'[a-z][a-z0-9-]{1,30}\Z')


class ProbeError(Exception):
    pass


def run(command, runner):
    result = runner(command)
    if result is None:
        raise ProbeError('unavailable command: ' + command[0])
    return result


def default_runner(command):
    env = None
    if command[0] == 'docker':
        env = {'HOME': '/root', 'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}
    try:
        result = subprocess.run(command, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.decode('utf-8', 'replace')


def uname_m(runner):
    return run(['uname', '-m'], runner).strip()


def ram_total_bytes():
    try:
        with open('/proc/meminfo', 'r', encoding='ascii') as handle:
            for line in handle:
                if line.startswith('MemTotal:'):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass
    try:
        return os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
    except (ValueError, OSError, AttributeError):
        return None


def docker_facts(runner):
    # Мягкие проверки: отсутствие docker/compose — предупреждение, не STOP.
    prefix = ['docker', '--config', '/etc/homecloud/docker',
              '--host', 'unix:///var/run/docker.sock']
    version = runner(prefix + ['version', '--format', '{{.Server.Version}}'])
    compose = runner(prefix + ['compose', 'version', '--short'])
    return {
        'present': version is not None,
        'version': version.strip() if version else None,
        'compose_version': compose.strip() if compose else None,
    }


def disks(runner):
    raw = run(['lsblk', '--json', '--bytes', '--nodeps',
               '-o', 'PATH,TYPE,SIZE,FSTYPE,UUID,SERIAL,RO,TRAN'], runner)
    if raw is None:
        raise ProbeError('lsblk unavailable: install util-linux')
    try:
        data = json.loads(raw)
    except ValueError as error:
        raise ProbeError('unexpected lsblk output: ' + str(error))
    result = []
    for device in data.get('blockdevices') or []:
        if device.get('type') != 'disk' or device.get('ro'):
            continue
        result.append({
            'path': device.get('path'),
            'size_bytes': device.get('size'),
            'fstype': device.get('fstype'),
            'uuid': device.get('uuid'),
            'serial': (device.get('serial') or '').strip() or None,
            'tran': device.get('tran'),
        })
    if not result:
        raise ProbeError('no writable whole disks reported by lsblk')
    return result


def disk_serial(runner, source):
    """Serial физического диска за блочным источником mount (part/lvm -> disk).
    Мягкий опрос: неразрешённый serial — None, не отказ probe."""
    raw = runner(['lsblk', '--json', '--inverse', '--paths',
                  '-o', 'PATH,TYPE,SERIAL', source])
    if raw is None:
        return None
    try:
        nodes = json.loads(raw).get('blockdevices') or []
    except ValueError:
        return None
    # Ответ обязан описывать цепочку именно запрошенного источника.
    if not nodes or all(node.get('path') != source for node in nodes):
        return None
    serial = None

    def visit(items):
        nonlocal serial
        for node in items:
            if node.get('type') == 'disk':
                serial = (node.get('serial') or '').strip() or None
            visit(node.get('children') or [])

    visit(nodes)
    return serial


def mounts(runner):
    raw = runner(['findmnt', '--json', '--list', '-o', 'TARGET,SOURCE,FSTYPE,UUID'])
    if raw is None:
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    rows = []
    serials = {}
    for row in data.get('filesystems') or []:
        item = {key: row.get(key) for key in ('target', 'source', 'fstype', 'uuid')}
        source = item['source'] or ''
        if source.startswith('/dev/'):
            if source not in serials:
                serials[source] = disk_serial(runner, source)
            item['serial'] = serials[source]
        else:
            item['serial'] = None
        rows.append(item)
    return rows


def listening_tcp_ports(runner):
    raw = runner(['ss', '-ltnH'])
    if raw is None:
        return []
    ports = set()
    for line in raw.splitlines():
        for token in line.split():
            if token.startswith(':'):
                token = token[1:]
            if ':' in token:
                token = token.rsplit(':', 1)[1]
            if token.isdigit():
                ports.add(int(token))
    return sorted(ports)


def primary_ip_and_interface(runner):
    raw = runner(['ip', '-json', 'route', 'show', 'default'])
    if raw is None:
        return None, None
    try:
        routes = json.loads(raw)
    except ValueError:
        return None, None
    for route in routes:
        prefs = route.get('prefsrc')
        device = route.get('dev')
        if prefs and device:
            return prefs, device
        if device:
            # A static default route need not carry prefsrc. A route lookup
            # asks the kernel which local source address it would use.
            lookup = runner(['ip', '-json', '-4', 'route', 'get', '1.1.1.1'])
            try:
                selected = json.loads(lookup) if lookup else []
            except ValueError:
                selected = []
            if type(selected) is list:
                for item in selected:
                    if type(item) is dict and item.get('dev') == device and item.get('prefsrc'):
                        return item['prefsrc'], device
    return None, None


def collect(runner=default_runner):
    arch = uname_m(runner)
    ip, interface = primary_ip_and_interface(runner)
    facts = {
        'format': FORMAT,
        'system': {
            'arch': arch,
            'kernel': platform.release(),
            'os': platform.system().lower(),
        },
        'resources': {
            'ram_total_bytes': ram_total_bytes(),
            'cpu_count': os.cpu_count(),
        },
        'docker': docker_facts(runner),
        'disks': disks(runner),
        'mounts': mounts(runner),
        'network': {
            'primary_ip': ip,
            'primary_interface': interface,
            'listening_tcp_ports': listening_tcp_ports(runner),
        },
        'warnings': [],
    }
    if arch != 'x86_64':
        facts['warnings'].append('qualified architecture is x86_64 only, got: ' + arch)
    if not facts['docker']['present']:
        facts['warnings'].append('docker daemon unavailable')
    if not facts['docker']['compose_version']:
        facts['warnings'].append('docker compose plugin unavailable')
    ram = facts['resources']['ram_total_bytes']
    if ram is not None and ram < 8 * 1024 ** 3:
        facts['warnings'].append('less than 8 GiB RAM')
    return facts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', help='write JSON to file instead of stdout')
    args = parser.parse_args()
    try:
        facts = collect()
    except ProbeError as error:
        print('STOP probe: ' + str(error), file=sys.stderr)
        return 2
    raw = json.dumps(facts, indent=2, sort_keys=True) + '\n'
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as handle:
            handle.write(raw)
        os.chmod(args.output, 0o600)
    else:
        sys.stdout.write(raw)
    return 0


if __name__ == '__main__':
    sys.exit(main())
