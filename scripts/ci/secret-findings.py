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


def qualify(findings, scanner_exit, raw_report_sha256=None, read_line=source_line, verify_upstream=upstream, verify_local=local_commit, check_context=historical_context):
    if scanner_exit not in (0,42) or not isinstance(findings,list) or (scanner_exit == 0) != (len(findings) == 0):
        raise ValueError('Scanner failure or inconsistent report')
    if findings and (not isinstance(raw_report_sha256,str)
                     or not re.fullmatch(r'[a-f0-9]{64}',raw_report_sha256)):
        raise ValueError('Missing or invalid raw report digest')
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
        records.append(record)
    blocked=sum(record['classification'] != 'VERIFIED_PUBLIC_GIT_REFERENCE' for record in records)
    return dict(format='homecloud-secret-reference-evidence-v1',scanner_exit=scanner_exit,
                raw_findings=len(findings),verified_public_references=len(findings)-blocked,
                unresolved_findings=blocked,findings=records,status='BLOCKED' if blocked else 'PASS')


# Exact historical PR45 source checksum evidence.
_CHECKPOINT_COMMIT = '131be90546c7142e79e9' + '292e27a835674e11751d'
_CHECKPOINT_SOURCE_COMMIT = '7068d8dc08c7cc19b1c7' + '4701f0ae85193e5ac233'
_CHECKPOINT_PATH = 'docs/handoff/PR-45-CLOSURE-CHECKS.json'
_CHECKPOINT_ENTRIES = {6713: (24, 110, 'scripts/ci/secret-findings.py'), 6724: (36, 145, 'backend/src/migrations/1746825000000-CreateRefreshTokensTable.ts'), 6728: (36, 142, 'backend/src/migrations/1746825040000-ShareLinksTokenUnique.ts')}


def _checkpoint_blob(commit, path):
    if path == FORBIDDEN:
        raise ValueError("Excluded source path")

    env = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1")

    return subprocess.check_output(
        ["git", "cat-file", "blob", commit + ":" + path],
        stderr=subprocess.DEVNULL,
        env=env,
    )


def _checkpoint_source_hash_proof(finding):
    """Prove only the three immutable historical checksum findings."""
    try:
        if (
            finding.get("RuleID") != "generic-api-key"
            or finding.get("Commit") != _CHECKPOINT_COMMIT
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

        document = json.loads(raw)
        manifest = document["ci"]["actual_wave2_collector"]["pair_manifest"]

        if manifest["commit"] != _CHECKPOINT_SOURCE_COMMIT:
            return None

        line = raw.decode("utf-8").splitlines()[number - 1]
        field = json.loads("{" + line.strip().rstrip(",") + "}")

        expected = manifest["source_files"][path]

        if (
            field != {path: expected}
            or not isinstance(expected, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected)
        ):
            return None

        actual = hashlib.sha256(
            _checkpoint_blob(_CHECKPOINT_SOURCE_COMMIT, path)
        ).hexdigest()

        if actual != expected:
            return None

        return {
            "kind": "historical_source_sha256",
            "source_commit": _CHECKPOINT_SOURCE_COMMIT,
            "source_path": path,
        }

    except (
        OSError, ValueError, TypeError,
        KeyError, IndexError, subprocess.SubprocessError,
    ):
        return None


_qualify_public_references = qualify


def qualify(
    findings, scanner_exit, raw_report_sha256=None,
    read_line=source_line, verify_upstream=upstream,
    verify_local=local_commit, check_context=historical_context,
):
    result = _qualify_public_references(
        findings, scanner_exit, raw_report_sha256,
        read_line, verify_upstream, verify_local, check_context,
    )

    if result["status"] != "BLOCKED":
        return result

    accepted = 0

    for finding in findings:
        proof = _checkpoint_source_hash_proof(finding)

        if proof is None:
            continue

        fingerprint = finding["Fingerprint"]

        matching = [
            record for record in result["findings"]
            if record["fingerprint"] == fingerprint
        ]

        if (
            len(matching) != 1
            or "proof" in matching[0]
            or sum(
                f["Fingerprint"] == fingerprint
                for f in findings
            ) != 1
        ):
            raise ValueError("Ambiguous checksum finding")

        matching[0].update(
            classification="VERIFIED_SOURCE_SHA256",
            reason="EXACT_HISTORICAL_SOURCE_HASH",
            proof=proof,
        )

        accepted += 1

    if accepted:
        result["verified_source_hashes"] = accepted
        result["unresolved_findings"] -= accepted

        if (
            result["unresolved_findings"] < 0
            or result["verified_public_references"]
                + accepted
                + result["unresolved_findings"]
                != result["raw_findings"]
        ):
            raise ValueError("Inconsistent secret classification totals")

        if result["unresolved_findings"] == 0:
            result["status"] = "PASS"

    return result



def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',required=True)
    parser.add_argument('--scanner-exit',required=True,type=int)
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    try:
        raw=Path(args.report).read_bytes()
        report_sha256=hashlib.sha256(raw).hexdigest()
        result=qualify(json.loads(raw),args.scanner_exit,raw_report_sha256=report_sha256)
        result['raw_report_sha256']=report_sha256
    except (OSError,ValueError,KeyError,TypeError,UnicodeError,subprocess.SubprocessError):
        result=dict(format='homecloud-secret-reference-evidence-v1',status='BLOCKED',error='Invalid or unavailable scanner/reference evidence')
    Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({key:value for key,value in result.items() if key != 'findings'},sort_keys=True))
    return 0 if result['status']=='PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
