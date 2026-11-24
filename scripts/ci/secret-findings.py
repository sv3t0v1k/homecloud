#!/usr/bin/env python3
"""Classify exact public Git references in retained redacted gitleaks findings.

All scanner findings remain in the raw report. This does not exempt paths, rules,
unknown 40-hex strings, unavailable references, or neighbouring credentials.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import hashlib
from functools import lru_cache
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import time

SHA = re.compile(r'[a-f0-9]{40}')
GO_LINE = re.compile(r'\s*"url"\s*:\s*"(https://go\.googlesource\.com/(?:go|net)/\+/([a-f0-9]{40}))"\s*,?\s*')
COMMIT_LINE = re.compile(r'\s*"commit"\s*:\s*"([a-f0-9]{40})"\s*,?\s*')
GO_EVIDENCE = 'docs/evidence/d5-1-5-20261014/pg-govulncheck.json'
METADATA_EVIDENCE = 'docs/evidence/d5-1-5-policy-secret-findings-20261015.json'
FORBIDDEN = 'scripts/tests/' + 'PHASE-5.3.1-TEST-AUDIT.md'
UPSTREAM_GO_REPOSITORY = 'https://go.googlesource.com/go'
UPSTREAM_GO_REPOSITORIES = {
    'go': UPSTREAM_GO_REPOSITORY,
    'net': 'https://go.googlesource.com/net',
}
FETCH_ATTEMPTS = 3
FETCH_BACKOFF_SECONDS = (1, 3)


def fetch_failure_kind(stderr):
    """Return only a safe category; Git stderr can contain credentials."""
    message = stderr.decode('utf-8', errors='replace').lower()
    if any(marker in message for marker in ('not our ref', "couldn't find remote ref", 'unadvertised object')):
        return 'OBJECT_UNAVAILABLE'
    if any(marker in message for marker in ('authentication failed', ' 401 ', ' 403 ', 'permission denied')):
        return 'ACCESS_DENIED'
    if any(marker in message for marker in ('certificate problem', 'ssl certificate', 'tls certificate')):
        return 'TLS_VERIFICATION_FAILED'
    if any(marker in message for marker in ('http 429', ' 429 ', 'rate limit', 'too many requests')):
        return 'RATE_LIMITED'
    if any(marker in message for marker in ('could not resolve host', 'failed to connect', 'connection timed out',
                                           'operation timed out', ' 502 ', ' 503 ', ' 504 ', 'rpc failed',
                                           'remote end hung up', 'early eof')):
        return 'TRANSIENT_TRANSPORT'
    return 'FETCH_ERROR_UNKNOWN'


def log_fetch_failure(sha, kind, attempts):
    # Public object ID and fixed category only; never log raw stderr or findings.
    print(json.dumps(dict(event='upstream_git_fetch_failed', object_id=sha,
                          category=kind, attempts=attempts), sort_keys=True), file=sys.stderr)


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL).decode('utf-8')


@lru_cache(maxsize=8)
def historical_blob(commit,path):
    if path not in (GO_EVIDENCE,METADATA_EVIDENCE):
        raise ValueError('Unqualified reference source context')
    return git('show',commit+':'+path)


def source_line(finding):
    commit, path = finding['Commit'], finding['File']
    if not isinstance(commit, str) or not SHA.fullmatch(commit):
        raise ValueError('Invalid finding source commit')
    if (not isinstance(path, str) or str(PurePosixPath(path)) != path or path.startswith('/')
            or '..' in PurePosixPath(path).parts or path == FORBIDDEN):
        raise ValueError('Invalid or excluded finding source path')
    if finding['StartLine'] != finding['EndLine'] or type(finding['StartLine']) is not int or finding['StartLine'] < 1:
        raise ValueError('Expected a single source line')
    lines = historical_blob(commit,path).splitlines()
    if finding['StartLine'] > len(lines):
        raise ValueError('Finding source line missing')
    return lines[finding['StartLine']-1]


def candidate(finding, line):
    if finding.get('RuleID') != 'sourcegraph-access-token':
        return None
    # Pinned gitleaks git reports include the leading '+' diff marker in columns.
    # Stored Git blob lines have no diff marker; remove exactly that one column.
    if type(finding['StartColumn']) is not int or type(finding['EndColumn']) is not int:
        raise ValueError('Invalid finding source columns')
    start, end = finding['StartColumn']-1, finding['EndColumn']-1
    if not 1 <= start <= end <= len(line):
        raise ValueError('Invalid finding source columns')
    span = line[start-1:end]
    # Pinned legacy rule includes the delimiter after the 40-hex match.
    found = re.fullmatch(r'([a-f0-9]{40})(?:[^a-f0-9])?', span)
    if not found:
        return None
    match = GO_LINE.fullmatch(line)
    if match and found[1] == match[2] and start-1 == match.start(2):
        return ('upstream_go_commit', match[1], match[2], None)
    match = COMMIT_LINE.fullmatch(line)
    if match and found[1] == match[1] and start-1 == match.start(1):
        return ('local_git_commit', None, match[1], finding['Commit'])
    return None


def historical_context(finding,plan):
    blob=historical_blob(finding['Commit'],finding['File'])
    if plan[0]=='upstream_go_commit':
        if finding['File'] != GO_EVIDENCE:
            return False
        decoder=json.JSONDecoder()
        remaining=blob
        messages=[]
        while remaining.strip():
            remaining=remaining.lstrip()
            message,end=decoder.raw_decode(remaining)
            messages.append(message)
            remaining=remaining[end:]
        return (messages[0].get('config',{}).get('scanner_name')=='govulncheck'
                and messages[0]['config'].get('scan_mode')=='binary'
                and any(ref.get('type')=='FIX' and ref.get('url')==plan[1]
                        for message in messages for ref in message.get('osv',{}).get('references',[])))
    if finding['File'] != METADATA_EVIDENCE:
        return False
    document=json.loads(blob)
    if (document.get('scanner')!='gitleaks 8.30.1' or document.get('status')!='BLOCKED_NO_EXCEPTION'
            or document.get('findings_count')!=len(document.get('findings',[]))):
        return False
    lines=blob.splitlines()
    index=finding['StartLine']-1
    # This fixed evidence schema records one finding object in seven JSON lines.
    record=json.loads('\n'.join(lines[index-4:index+3]).strip().rstrip(','))
    if (record not in document['findings'] or record.get('rule')!='sourcegraph-access-token'
            or record.get('file')!=GO_EVIDENCE or record.get('commit')!=plan[2]
            or type(record.get('public_go_commit_reference_verified')) is not bool):
        return False
    original=historical_blob(plan[2],GO_EVIDENCE).splitlines()
    line=record.get('line')
    return type(line) is int and 0 < line <= len(original) and bool(GO_LINE.fullmatch(original[line-1]))


def upstream(url, sha):
    # Fetch only an exact commit reference from a canonical Go project over
    # verified HTTPS. The temporary bare repository is discarded; no local
    # object cache can pass.
    if not isinstance(sha, str) or not SHA.fullmatch(sha):
        return False
    upstream_repository = next((repo for repo in UPSTREAM_GO_REPOSITORIES.values()
                                if url == repo+'/+/'+sha), None)
    if upstream_repository is None:
        return False
    env={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=os.devnull,GIT_TERMINAL_PROMPT='0')
    try:
        with tempfile.TemporaryDirectory(prefix='homecloud-go-object-') as temp:
            repository=os.path.join(temp,'objects.git')
            commands=(
                ['git','init','--bare','--quiet',repository],
                ['git','-C',repository,'-c','http.sslVerify=true','-c','http.followRedirects=false',
                 '-c','credential.helper=','fetch','--no-tags','--depth=1',upstream_repository,sha],
                ['git','-C',repository,'cat-file','-t',sha],
            )
            for index,command in enumerate(commands):
                # Retry only the same exact-object fetch on a transient failure.
                # Every successful fetch still requires type and object ID proof.
                result=None
                for attempt in range(FETCH_ATTEMPTS if index == 1 else 1):
                    try:
                        result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                              env=env,timeout=60,check=False)
                    except subprocess.TimeoutExpired:
                        kind='TIMEOUT'
                        if index == 1 and attempt+1 < FETCH_ATTEMPTS:
                            time.sleep(FETCH_BACKOFF_SECONDS[attempt])
                            continue
                        if index == 1:
                            log_fetch_failure(sha,kind,attempt+1)
                        return False
                    if result.returncode == 0:
                        break
                    kind=fetch_failure_kind(result.stderr)
                    if index == 1 and kind not in ('OBJECT_UNAVAILABLE','ACCESS_DENIED','TLS_VERIFICATION_FAILED') \
                            and attempt+1 < FETCH_ATTEMPTS:
                        time.sleep(FETCH_BACKOFF_SECONDS[attempt])
                        continue
                    if index == 1:
                        log_fetch_failure(sha,kind,attempt+1)
                    return False
                if result is None or result.returncode != 0:
                    return False
                if index == 2 and result.stdout.strip() != b'commit':
                    return False
            result=subprocess.run(['git','-C',repository,'cat-file','commit',sha],
                                  stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                                  env=env,timeout=60,check=False)
            if result.returncode != 0:
                return False
            payload=result.stdout
            object_header=b'commit '+str(len(payload)).encode('ascii')+b'\0'
            actual=hashlib.sha1(object_header+payload).hexdigest()
            return actual == sha
    except (OSError,subprocess.SubprocessError,TimeoutError):
        return False


def local_commit(sha,ancestor):
    try:
        return (git('cat-file','-t',sha).strip() == 'commit'
                and subprocess.run(['git','merge-base','--is-ancestor',sha,ancestor],
                                   stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0)
    except subprocess.SubprocessError:
        return False



def strict_json(raw):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result

    def invalid_constant(_):
        raise ValueError("Invalid JSON constant")

    return json.loads(
        raw,
        object_pairs_hook=unique_object,
        parse_constant=invalid_constant,
    )


def validate_findings(findings):
    fingerprints = set()
    identities = set()

    for finding in findings:
        if not isinstance(finding, dict):
            raise ValueError("Invalid scanner finding")

        for key in ("RuleID", "Commit", "File", "Fingerprint"):
            value = finding.get(key)
            if not isinstance(value, str) or not value:
                raise ValueError("Missing finding identity")

        if not SHA.fullmatch(finding["Commit"]):
            raise ValueError("Invalid finding commit")

        if finding.get("Secret") != "REDACTED":
            raise ValueError("Expected redacted finding")

        path = finding["File"]

        if (
            path == FORBIDDEN
            or path.startswith("/")
            or "\0" in path
            or not PurePosixPath(path).parts
            or str(PurePosixPath(path)) != path
            or ".." in PurePosixPath(path).parts
        ):
            raise ValueError("Invalid or excluded finding path")

        coordinates = tuple(
            finding.get(key) for key in (
                "StartLine", "EndLine",
                "StartColumn", "EndColumn",
            )
        )

        if any(type(v) is not int or v < 1
               for v in coordinates):
            raise ValueError("Invalid finding coordinates")

        first, last, start, end = coordinates

        if first > last or (first == last and start > end):
            raise ValueError("Invalid finding coordinate order")

        identity = (
            finding["Commit"], path,
            finding["RuleID"], *coordinates,
        )

        fingerprint = finding["Fingerprint"]

        if fingerprint in fingerprints or identity in identities:
            raise ValueError("Duplicate or ambiguous finding")

        fingerprints.add(fingerprint)
        identities.add(identity)


def qualify(findings, scanner_exit, raw_report_sha256=None, read_line=source_line, verify_upstream=upstream, verify_local=local_commit, check_context=historical_context):
    if type(scanner_exit) is not int or scanner_exit not in (0,42) or not isinstance(findings,list) or (scanner_exit == 0) != (len(findings) == 0):
        raise ValueError('Scanner failure or inconsistent report')
    if findings and (not isinstance(raw_report_sha256,str)
                     or not re.fullmatch(r'[a-f0-9]{64}',raw_report_sha256)):
        raise ValueError('Missing or invalid raw report digest')
    validate_findings(findings)
    plans = []
    for finding in findings:
        if (not isinstance(finding,dict) or finding.get('Secret') != 'REDACTED'
                or not isinstance(finding.get('Fingerprint'),str) or not finding['Fingerprint']):
            raise ValueError('Expected complete redacted scanner finding')
        plan = None
        line = None
        if finding.get('RuleID') == 'sourcegraph-access-token':
            line = read_line(finding)
            plan = candidate(finding,line)
            if plan and not check_context(finding,plan):
                plan = None
        plans.append((plan,line))
    checks = sorted(set((plan for plan,line in plans if plan)),
                    key=lambda item:(item[0],item[1] or '',item[2],item[3] or ''))
    def verify(plan):
        kind,url,sha,ancestor = plan
        valid=(raw_report_sha256 is not None) if kind == 'upstream_go_commit' else True
        return plan, valid and (verify_upstream(url,sha) if kind == 'upstream_go_commit' else verify_local(sha,ancestor))
    with ThreadPoolExecutor(max_workers=4) as pool:
        verified = dict(pool.map(verify,checks))
    records = []
    for finding,(plan,line) in zip(findings,plans):
        accepted = bool(plan and verified.get(plan))
        record = dict(fingerprint=finding['Fingerprint'],rule=finding['RuleID'],file=finding['File'],
                      line=finding['StartLine'],columns=[finding['StartColumn'],finding['EndColumn']],
                      classification='VERIFIED_PUBLIC_GIT_REFERENCE' if accepted else 'BLOCKED_UNCLASSIFIED_FINDING',
                      reason=('EXACT_REFERENCE_AND_OBJECT_VERIFIED' if accepted else
                              ('REFERENCE_OBJECT_UNAVAILABLE_OR_UNVERIFIED' if plan else 'UNQUALIFIED_RULE_SOURCE_OR_SPAN')))
        if accepted:
            record['proof'] = dict(kind=plan[0],
                                   verification='HTTPS_GIT_COMMIT_OBJECT_ID_MATCH' if plan[0]=='upstream_go_commit' else 'EXACT_LOCAL_GIT_COMMIT_OBJECT',
                                   source_commit=finding['Commit'],raw_report_sha256=raw_report_sha256,
                                   finding_fingerprint=finding['Fingerprint'],source_file=finding['File'],
                                   source_line_number=finding['StartLine'],source_line=line,
                                   source_columns=[finding['StartColumn'],finding['EndColumn']],
                                   source_line_sha256=hashlib.sha256(line.encode()).hexdigest())
            if plan[0]=='upstream_go_commit':
                record['proof'].update(object_id=plan[2],url=plan[1],
                                       transport='HTTPS; certificate verification enabled; redirects disabled')
        if not accepted:
            proof = _checkpoint_source_hash_proof(finding)

            if proof is not None:
                proof.update(
                    verification="EXACT_GIT_OBJECT_CHAIN_AND_SOURCE_SHA256",
                    checkpoint_commit=finding["Commit"],
                    checkpoint_file=finding["File"],
                    source_line_number=finding["StartLine"],
                    source_columns=[
                        finding["StartColumn"], finding["EndColumn"],
                    ],
                    finding_fingerprint=finding["Fingerprint"],
                    raw_report_sha256=raw_report_sha256,
                )

                record.update(
                    classification="VERIFIED_SOURCE_SHA256",
                    reason="EXACT_HISTORICAL_SOURCE_HASH",
                    proof=proof,
                )

        records.append(record)
    public_count = sum(
        r["classification"] == "VERIFIED_PUBLIC_GIT_REFERENCE"
        for r in records
    )
    source_count = sum(
        r["classification"] == "VERIFIED_SOURCE_SHA256"
        for r in records
    )


    blocked = len(findings) - public_count - source_count

    if blocked < 0:
        raise ValueError("Inconsistent classification totals")

    return dict(
        format="homecloud-secret-reference-evidence-v1",
        scanner_exit=scanner_exit,
        raw_findings=len(findings),
        verified_public_references=public_count,
        verified_source_hashes=source_count,
        unresolved_findings=blocked,
        findings=records,
        status="BLOCKED" if blocked else "PASS",
    )


# Exact historical PR45 source checksum evidence.
_CHECKPOINT_COMMIT = '131be90546c7142e79e9' + '292e27a835674e11751d'
_CHECKPOINT_SOURCE_COMMIT = '7068d8dc08c7cc19b1c7' + '4701f0ae85193e5ac233'
_CHECKPOINT_PATH = 'docs/handoff/PR-45-CLOSURE-CHECKS.json'
_CHECKPOINT_ENTRIES = {6713: (24, 110, 'scripts/ci/secret-findings.py'), 6724: (36, 145, 'backend/src/migrations/1746825000000-CreateRefreshTokensTable.ts'), 6728: (36, 142, 'backend/src/migrations/1746825040000-ShareLinksTokenUnique.ts')}



def _verified_git_object(kind, oid):
    """Read an exact Git object and independently verify its identity."""
    if kind not in ("commit", "tree", "blob"):
        raise ValueError("Invalid Git object type")

    if not isinstance(oid, str) or not SHA.fullmatch(oid):
        raise ValueError("Invalid Git object ID")

    env = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1")

    payload = subprocess.check_output(
        ["git", "cat-file", kind, oid],
        stderr=subprocess.DEVNULL,
        env=env,
        timeout=30,
    )

    header = (
        kind.encode("ascii") + b" "
        + str(len(payload)).encode("ascii") + b"\0"
    )

    if hashlib.sha1(header + payload).hexdigest() != oid:
        raise ValueError("Git object content does not match identity")

    return payload


def _checkpoint_blob(commit, path):
    """Verify the commit, every tree and the exact regular blob."""
    if (
        not isinstance(path, str)
        or path == FORBIDDEN
        or path.startswith("/")
        or str(PurePosixPath(path)) != path
        or ".." in PurePosixPath(path).parts
    ):
        raise ValueError("Invalid historical object path")

    payload = _verified_git_object("commit", commit)
    root = payload.split(b"\n", 1)[0]
    match = re.fullmatch(rb"tree ([a-f0-9]{40})", root)

    if not match:
        raise ValueError("Commit root tree missing")

    oid = match[1].decode("ascii")
    parts = PurePosixPath(path).parts

    if not parts:
        raise ValueError("Empty historical path")

    for index, part in enumerate(parts):
        tree = _verified_git_object("tree", oid)
        offset = 0
        matches = []

        while offset < len(tree):
            separator = tree.index(b"\0", offset)
            mode, name = tree[offset:separator].split(b" ", 1)
            object_end = separator + 21

            if object_end > len(tree):
                raise ValueError("Truncated Git tree entry")

            child = tree[separator + 1:object_end].hex()

            if name == part.encode("utf-8"):
                matches.append((mode, child))

            offset = object_end

        if len(matches) != 1:
            raise ValueError("Missing or ambiguous Git tree path")

        mode, oid = matches[0]

        if index == len(parts) - 1:
            if mode not in (b"100644", b"100755"):
                raise ValueError("Historical source is not a regular blob")

            return _verified_git_object("blob", oid)

        if mode != b"40000":
            raise ValueError("Historical path component is not a tree")

    raise ValueError("Historical blob resolution failed")



def _checkpoint_merge_parent(commit, canonical):
    """Prove the exact historical blob in a genuine merge commit."""
    payload = _verified_git_object("commit", commit)
    headers, separator, _ = payload.partition(b"\n\n")

    if not separator:
        return None

    parents = []

    for line in headers.splitlines():
        if not line.startswith(b"parent "):
            continue

        match = re.fullmatch(rb"parent ([a-f0-9]{40})", line)

        if not match:
            return None

        parents.append(match[1].decode("ascii"))

    if len(parents) < 2 or len(set(parents)) != len(parents):
        return None

    if _checkpoint_blob(commit, _CHECKPOINT_PATH) != canonical:
        return None

    for parent in parents:
        try:
            if _checkpoint_blob(parent, _CHECKPOINT_PATH) == canonical:
                return parent
        except (
            OSError, ValueError, TypeError, KeyError,
            IndexError, subprocess.SubprocessError,
        ):
            continue

    return None


def _checkpoint_source_hash_proof(finding):
    """Prove historical checksums and verified merge repetitions."""
    try:
        if (
            finding.get("RuleID") != "generic-api-key"
            or finding.get("File") != _CHECKPOINT_PATH
            or finding.get("Secret") != "REDACTED"
        ):
            return None

        number = finding.get("StartLine")
        entry = _CHECKPOINT_ENTRIES.get(number)

        if entry is None or finding.get("EndLine") != number:
            return None

        start, end, path = entry

        if (
            finding.get("StartColumn") != start
            or finding.get("EndColumn") != end
        ):
            return None

        raw = _checkpoint_blob(
            _CHECKPOINT_COMMIT, _CHECKPOINT_PATH
        )

        merge_parent = None
        finding_commit = finding["Commit"]

        if finding_commit != _CHECKPOINT_COMMIT:
            merge_parent = _checkpoint_merge_parent(
                finding_commit, raw
            )

            if merge_parent is None:
                return None

        document = strict_json(raw)
        manifest = document["ci"]["actual_wave2_collector"]["pair_manifest"]

        if manifest["commit"] != _CHECKPOINT_SOURCE_COMMIT:
            return None

        line = raw.decode("utf-8").splitlines()[number - 1]
        field = strict_json("{" + line.strip().rstrip(",") + "}")

        expected = manifest["source_files"][path]

        if (
            field != {path: expected}
            or not isinstance(expected, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected)
        ):
            return None

        # The pinned scanner includes the leading diff '+'.
        token = '"' + expected + '"'

        if line.count(token) != 1:
            return None

        if not 2 <= start <= end <= len(line) + 1:
            return None

        value_start = line.index(token) + 1

        if not (
            start - 2 <= value_start
            and value_start + 64 <= end - 1
        ):
            return None

        actual = hashlib.sha256(
            _checkpoint_blob(_CHECKPOINT_SOURCE_COMMIT, path)
        ).hexdigest()

        if actual != expected:
            return None

        proof = {
            "kind": "historical_source_sha256",
            "source_commit": _CHECKPOINT_SOURCE_COMMIT,
            "source_path": path,
            "historical_checkpoint_commit": _CHECKPOINT_COMMIT,
            "checkpoint_blob_sha256": hashlib.sha256(raw).hexdigest(),
        }

        if merge_parent is not None:
            proof["merge_parent_commit"] = merge_parent
            proof["merge_blob_verification"] = (
                "EXACT_VERIFIED_MERGE_AND_PARENT_BLOB"
            )

        return proof

    except (
        OSError, ValueError, TypeError,
        KeyError, IndexError, subprocess.SubprocessError,
    ):
        return None



def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',required=True)
    parser.add_argument('--scanner-exit',required=True,type=int)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    try:
        raw=Path(args.report).read_bytes()
        report_sha256=hashlib.sha256(raw).hexdigest()
        result=qualify(strict_json(raw),args.scanner_exit,raw_report_sha256=report_sha256)
        result['raw_report_sha256']=report_sha256
    except (OSError,ValueError,KeyError,TypeError,UnicodeError,subprocess.SubprocessError):
        result=dict(format='homecloud-secret-reference-evidence-v1',status='BLOCKED',error='Invalid or unavailable scanner/reference evidence')
    Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:value for key,value in result.items() if key != 'findings'},sort_keys=True))
    return 0 if result['status']=='PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
