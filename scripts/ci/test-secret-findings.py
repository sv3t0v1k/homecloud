#!/usr/bin/env python3
"""Public-reference proof must not accept adjacent or unrelated credentials."""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch, MagicMock

spec=importlib.util.spec_from_file_location('secrets',Path(__file__).with_name('secret-findings.py'))
s=importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
SHA='a'*40
URL='https://go.googlesource.com/go/+/'+SHA
REPORT_SHA='d'*64


class Tests(unittest.TestCase):
    def finding(self,line,sha=SHA,rule='sourcegraph-access-token'):
        start=line.index(sha)
        return dict(RuleID=rule,Commit='b'*40,File='fixture.json',StartLine=1,EndLine=1,
                    StartColumn=start+2,EndColumn=start+42,Secret='REDACTED',Fingerprint='fixture')

    def check(self,line,verified=True,rule='sourcegraph-access-token',sha=SHA):
        return s.qualify([self.finding(line,sha,rule)],42,raw_report_sha256=REPORT_SHA,read_line=lambda finding:line,
                         verify_upstream=lambda url,sha:verified,verify_local=lambda sha,ancestor:verified,check_context=lambda *args:True)

    def test_exact_upstream_and_local_object(self):
        upstream_line='  "url": "'+URL+'",'
        result=self.check(upstream_line)
        self.assertEqual(result['status'],'PASS')
        self.assertEqual(result['raw_findings'],1)
        self.assertEqual(result['findings'][0]['classification'],'VERIFIED_PUBLIC_GIT_REFERENCE')
        self.assertEqual(self.check(upstream_line,verified=False)['status'],'BLOCKED')

        local_line='  "commit": "'+SHA+'",'
        finding=self.finding(local_line)
        with patch.object(s,'upstream') as verify_upstream, patch.object(s,'local_commit',return_value=True) as verify_local:
            result=s.qualify([finding],42,raw_report_sha256=REPORT_SHA,
                             read_line=lambda _:local_line,verify_local=s.local_commit,
                             verify_upstream=s.upstream,check_context=lambda *_:True)
        self.assertEqual(result['status'],'PASS')
        verify_local.assert_called_once_with(SHA,'b'*40)
        verify_upstream.assert_not_called()

    def test_spoofed_host_path_key_and_adjacent_token_block(self):
        for line in ('"url":"https://go.googlesource.com.evil/go/+/'+SHA+'"',
                     '"url":"https://go.googlesource.com/go/+/'+SHA+'?token=x"',
                     '"url":"https://go.googlesource.com/unknown/+/'+SHA+'"',
                     '"url":"http://go.googlesource.com/go/+/'+SHA+'"',
                     '"token":"'+SHA+'"',
                     '"url":"'+URL+'", "token":"'+'c'*40+'"',
                     '"commit":"'+SHA+'", "token":"'+'c'*40+'"'):
            self.assertEqual(self.check(line)['status'],'BLOCKED')
        adjacent='"url":"'+URL+'", "token":"'+'c'*40+'"'
        self.assertEqual(self.check(adjacent,sha='c'*40)['status'],'BLOCKED')

    def test_other_rule_and_coordinate_mismatch_stay_blocked(self):
        line='"url":"'+URL+'"'
        self.assertEqual(self.check(line,rule='github-pat')['status'],'BLOCKED')
        finding=self.finding(line)
        finding['StartColumn']+=1
        result=s.qualify([finding],42,raw_report_sha256=REPORT_SHA,read_line=lambda f:line,verify_upstream=lambda *args:True,check_context=lambda *args:True)
        self.assertEqual(result['status'],'BLOCKED')

    def test_infrastructure_and_malformed_report_fail_closed(self):
        for findings,code in (([],1),([],42),([{}],42),({},0),([dict(Secret='raw')],42)):
            with self.subTest(findings=findings,code=code),self.assertRaises(ValueError):
                s.qualify(findings,code)
        self.assertEqual(s.qualify([],0)['status'],'PASS')

    def test_forbidden_source_never_read(self):
        finding=self.finding('"commit":"'+SHA+'"')
        finding['File']=s.FORBIDDEN
        with self.assertRaises(ValueError):
            s.source_line(finding)

    def test_unknown_local_sha_does_not_pass_as_metadata(self):
        result=s.qualify([self.finding('"commit":"'+SHA+'"')],42,
                         raw_report_sha256=REPORT_SHA,read_line=lambda f:'"commit":"'+SHA+'"',verify_local=lambda sha,ancestor:False,check_context=lambda *args:True)
        self.assertEqual(result['status'],'BLOCKED')

    def test_arbitrary_source_context_is_never_qualified(self):
        finding=self.finding('"commit":"'+SHA+'"')
        with self.assertRaises(ValueError):
            s.historical_context(finding,('local_git_commit',None,SHA,'b'*40))

    def test_local_commit_must_be_ancestor_of_finding_history(self):
        with patch.object(s,'git',return_value='commit'),patch.object(s.subprocess,'run') as run:
            run.return_value.returncode=1
            self.assertFalse(s.local_commit(SHA,'b'*40))
            run.return_value.returncode=0
            self.assertTrue(s.local_commit(SHA,'b'*40))
            self.assertEqual(run.call_args.args[0],['git','merge-base','--is-ancestor',SHA,'b'*40])

    def test_old_url_false_flag_requires_independent_local_object_proof(self):
        record=dict(rule='sourcegraph-access-token',file=s.GO_EVIDENCE,line=1,
                    commit=SHA,public_go_commit_reference_verified=False)
        blob=json.dumps(dict(status='BLOCKED_NO_EXCEPTION',scanner='gitleaks 8.30.1',
                             findings_count=1,findings=[record]),indent=2)
        line_number=next(index+1 for index,line in enumerate(blob.splitlines()) if '"commit"' in line)
        line=blob.splitlines()[line_number-1]
        finding=self.finding(line)
        finding.update(File=s.METADATA_EVIDENCE,StartLine=line_number,EndLine=line_number)
        def historical(commit,path):
            return blob if path==s.METADATA_EVIDENCE else '"url":"'+URL+'"'
        with patch.object(s,'historical_blob',side_effect=historical):
            for verified in (False,True):
                result=s.qualify([finding],42,raw_report_sha256=REPORT_SHA,read_line=lambda f:line,
                                 verify_local=lambda sha,ancestor:verified)
                self.assertEqual(result['status'],'PASS' if verified else 'BLOCKED')
                if verified:
                    proof=result['findings'][0]['proof']
                    self.assertEqual(proof['verification'],'EXACT_LOCAL_GIT_COMMIT_OBJECT')
                    self.assertEqual(proof['raw_report_sha256'],REPORT_SHA)
                    self.assertEqual(proof['finding_fingerprint'],finding['Fingerprint'])
                    self.assertEqual(proof['source_line'],line)
                    self.assertEqual(proof['source_file'],finding['File'])
                    self.assertEqual(proof['source_line_number'],finding['StartLine'])
                    self.assertEqual(proof['source_columns'],[finding['StartColumn'],finding['EndColumn']])
                    self.assertEqual(proof['source_line_sha256'],hashlib.sha256(line.encode()).hexdigest())

    def test_column_types_rejected_before_arithmetic(self):
        line='"url":"'+URL+'"'
        for value in (None,'10',True,1.5):
            finding=self.finding(line)
            finding['StartColumn']=value
            with self.subTest(value=value),self.assertRaises(ValueError):
                s.candidate(finding,line)

    def synthetic_commit(self,body=b'local test commit'):
        payload=(b'tree '+b'0'*40+b'\nparent '+b'1'*40+b'\n'
                 b'author Test <test@example.invalid> 0 +0000\n'
                 b'committer Test <test@example.invalid> 0 +0000\n\n'+body+b'\n')
        oid=hashlib.sha1(b'commit '+str(len(payload)).encode()+b'\0'+payload).hexdigest()
        return payload,oid

    def git_run_stub(self,payload,fetch_status=0,fetch_stderr=b''):
        calls=[]
        fetches=0
        def run(command,**kwargs):
            nonlocal fetches
            calls.append((command,kwargs))
            if 'fetch' in command:
                status=(fetch_status[min(fetches,len(fetch_status)-1)]
                        if isinstance(fetch_status,tuple) else fetch_status)
                fetches+=1
                return SimpleNamespace(returncode=status,stdout=b'',stderr=fetch_stderr)
            if command[-3:-1]==['cat-file','-t']:
                return SimpleNamespace(returncode=0,stdout=b'commit\n',stderr=b'')
            if command[-3:-1]==['cat-file','commit']:
                return SimpleNamespace(returncode=0,stdout=payload,stderr=b'')
            return SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
        return calls,run

    def test_upstream_fetch_success_binds_report_fingerprint_and_source_line(self):
        payload,sha=self.synthetic_commit()
        url=s.UPSTREAM_GO_REPOSITORY+'/+/'+sha
        line='  "url": "'+url+'",'
        finding=self.finding(line,sha)
        calls,run=self.git_run_stub(payload)
        with patch.object(s.subprocess,'run',side_effect=run):
            result=s.qualify([finding],42,raw_report_sha256=REPORT_SHA,
                             read_line=lambda _:line,check_context=lambda *_:True)
        self.assertEqual(result['status'],'PASS')
        proof=result['findings'][0]['proof']
        self.assertEqual(proof['raw_report_sha256'],REPORT_SHA)
        self.assertEqual(proof['finding_fingerprint'],finding['Fingerprint'])
        self.assertEqual(proof['source_line'],line)
        self.assertEqual(proof['source_line_sha256'],hashlib.sha256(line.encode()).hexdigest())
        self.assertEqual(proof['source_columns'],[finding['StartColumn'],finding['EndColumn']])
        self.assertEqual(proof['object_id'],sha)
        fetch,kwargs=next((command,kwargs) for command,kwargs in calls if 'fetch' in command)
        self.assertEqual(fetch[-2:],[s.UPSTREAM_GO_REPOSITORY,sha])
        self.assertIn('http.sslVerify=true',fetch)
        self.assertIn('http.followRedirects=false',fetch)
        self.assertEqual(kwargs['env']['GIT_CONFIG_NOSYSTEM'],'1')
        self.assertEqual(kwargs['env']['GIT_CONFIG_GLOBAL'],os.devnull)
        self.assertEqual(kwargs['env']['GIT_TERMINAL_PROMPT'],'0')
        for key in ('GIT_SSL_NO_VERIFY','GIT_CONFIG_COUNT','GIT_DIR','GIT_WORK_TREE'):
            self.assertNotIn(key,kwargs['env'])

    def test_unlisted_canonical_go_and_net_objects_are_verified_by_exact_oid(self):
        payload,sha=self.synthetic_commit(b'previously unlisted canonical object')
        for project in ('go','net'):
            url=f'https://go.googlesource.com/{project}/+/{sha}'
            calls,run=self.git_run_stub(payload)
            with patch.object(s.subprocess,'run',side_effect=run):
                self.assertTrue(s.upstream(url,sha))
            fetch,kwargs=next((command,kwargs) for command,kwargs in calls if 'fetch' in command)
            self.assertEqual(fetch[-2:],[f'https://go.googlesource.com/{project}',sha])
            self.assertIn('http.sslVerify=true',fetch)
            self.assertIn('http.followRedirects=false',fetch)

    def test_noncanonical_upstream_locations_never_start_network(self):
        unknown='f'*40
        with patch.object(s.subprocess,'run') as run:
            self.assertFalse(s.upstream(s.UPSTREAM_GO_REPOSITORY+'/+/g'+unknown[1:],unknown))
            self.assertFalse(s.upstream('https://go.googlesource.com.evil/go/+/'+unknown,unknown))
            self.assertFalse(s.upstream('https://go.googlesource.com/other/+/'+unknown,unknown))
            self.assertFalse(s.upstream('http://go.googlesource.com/go/+/'+unknown,unknown))
            self.assertFalse(s.upstream(s.UPSTREAM_GO_REPOSITORY+'/+/'+unknown,'x'*40))
            run.assert_not_called()

    def test_upstream_object_substitution_stays_blocked(self):
        _,sha=self.synthetic_commit()
        wrong_payload,_=self.synthetic_commit(b'substituted object')
        url=s.UPSTREAM_GO_REPOSITORY+'/+/'+sha
        line='"url":"'+url+'"'
        calls,run=self.git_run_stub(wrong_payload)
        with patch.object(s.subprocess,'run',side_effect=run):
            self.assertFalse(s.upstream(url,sha))
        self.assertEqual(sum('fetch' in command for command,_ in calls),1)

    def test_upstream_network_failure_stays_blocked_after_bounded_retry(self):
        payload,sha=self.synthetic_commit()
        url=s.UPSTREAM_GO_REPOSITORY+'/+/'+sha
        line='"url":"'+url+'"'
        finding=self.finding(line,sha)
        calls,run=self.git_run_stub(payload,fetch_status=1)
        with patch.object(s.subprocess,'run',side_effect=run),patch.object(s.time,'sleep'):
            result=s.qualify([finding],42,raw_report_sha256=REPORT_SHA,
                             read_line=lambda _:line,check_context=lambda *_:True)
        self.assertEqual(result['status'],'BLOCKED')
        self.assertEqual(result['unresolved_findings'],1)
        self.assertEqual(sum('fetch' in command for command,_ in calls),3)

    def test_transient_fetch_retries_only_the_same_exact_object(self):
        payload,sha=self.synthetic_commit()
        url=s.UPSTREAM_GO_REPOSITORY+'/+/'+sha
        calls,run=self.git_run_stub(payload,fetch_status=(1,0))
        with patch.object(s.subprocess,'run',side_effect=run),patch.object(s.time,'sleep'):
            self.assertTrue(s.upstream(url,sha))
        fetches=[command for command,_ in calls if 'fetch' in command]
        self.assertEqual(len(fetches),2)
        self.assertEqual(fetches[0],fetches[1])
        self.assertEqual(fetches[0][-2:],[s.UPSTREAM_GO_REPOSITORY,sha])

    def test_transient_timeout_retries_without_exposing_git_stderr(self):
        payload,sha=self.synthetic_commit()
        calls,run=self.git_run_stub(payload)
        failed=[False]
        def timeout_once(command,**kwargs):
            if 'fetch' in command and not failed[0]:
                failed[0]=True
                raise s.subprocess.TimeoutExpired(command,60)
            return run(command,**kwargs)
        with patch.object(s.subprocess,'run',side_effect=timeout_once),patch.object(s.time,'sleep') as sleep:
            self.assertTrue(s.upstream(s.UPSTREAM_GO_REPOSITORY+'/+/'+sha,sha))
        sleep.assert_called_once_with(1)

    def test_missing_object_fails_without_retry_and_logs_only_category(self):
        payload,sha=self.synthetic_commit()
        calls,run=self.git_run_stub(payload,fetch_status=128,
                                    fetch_stderr=b'fatal: remote error: upload-pack: not our ref private-secret-value')
        output=io.StringIO()
        with patch.object(s.subprocess,'run',side_effect=run),patch.object(s.sys,'stderr',output), \
                patch.object(s.time,'sleep') as sleep:
            self.assertFalse(s.upstream(s.UPSTREAM_GO_REPOSITORY+'/+/'+sha,sha))
        self.assertEqual(sum('fetch' in command for command,_ in calls),1)
        sleep.assert_not_called()
        self.assertIn('OBJECT_UNAVAILABLE',output.getvalue())
        self.assertNotIn('private-secret-value',output.getvalue())

    def test_rate_limit_retries_same_sha_then_blocks(self):
        payload,sha=self.synthetic_commit()
        calls,run=self.git_run_stub(payload,fetch_status=429,fetch_stderr=b'HTTP 429')
        output=io.StringIO()
        with patch.object(s.subprocess,'run',side_effect=run),patch.object(s.sys,'stderr',output), \
                patch.object(s.time,'sleep') as sleep:
            self.assertFalse(s.upstream(s.UPSTREAM_GO_REPOSITORY+'/+/'+sha,sha))
        self.assertEqual(sum('fetch' in command for command,_ in calls),3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list],[1,3])
        self.assertIn('RATE_LIMITED',output.getvalue())

    def test_upstream_without_raw_report_digest_stays_blocked(self):
        payload,sha=self.synthetic_commit()
        url=s.UPSTREAM_GO_REPOSITORY+'/+/'+sha
        line='"url":"'+url+'"'
        finding=self.finding(line,sha)
        calls,run=self.git_run_stub(payload)
        with patch.object(s.subprocess,'run',side_effect=run):
            with self.assertRaises(ValueError):
                s.qualify([finding],42,read_line=lambda _:line,check_context=lambda *_:True)
        self.assertFalse(any('fetch' in command for command,_ in calls))

    def test_invalid_or_missing_fingerprint_and_digest_fail_closed(self):
        line='"url":"'+URL+'"'
        finding=self.finding(line)
        finding['Fingerprint']=''
        with self.assertRaises(ValueError):
            s.qualify([finding],42,raw_report_sha256=REPORT_SHA,read_line=lambda _:line)
        finding=self.finding(line)
        with self.assertRaises(ValueError):
            s.qualify([finding],42,read_line=lambda _:line,check_context=lambda *_:True)
        with self.assertRaises(ValueError):
            s.qualify([finding],42,raw_report_sha256='xyz',read_line=lambda _:line)

    def test_unqualified_context_and_real_credentials_never_request_upstream(self):
        lines=('"url":"'+URL+'"','"token":"'+SHA+'"',
               '"url":"'+URL+'", "token":"'+'c'*40+'"')
        with patch.object(s.subprocess,'run') as run:
            for line in lines:
                result=s.qualify([self.finding(line)],42,raw_report_sha256=REPORT_SHA,read_line=lambda f:line,check_context=lambda *args:False)
                self.assertEqual(result['status'],'BLOCKED')
            real_secret=self.finding(lines[0],rule='github-pat')
            self.assertEqual(s.qualify([real_secret],42,raw_report_sha256=REPORT_SHA)['status'],'BLOCKED')
            run.assert_not_called()


class CheckpointSourceHashTests(unittest.TestCase):

    def setUp(self):
        self.path = "scripts/ci/fixture.py"
        self.content = b"source fixture\n"

        digest = hashlib.sha256(self.content).hexdigest()

        document = {
            "ci": {
                "actual_wave2_collector": {
                    "pair_manifest": {
                        "commit": s._CHECKPOINT_SOURCE_COMMIT,
                        "source_files": {self.path: digest},
                    },
                },
            },
        }

        self.raw = json.dumps(document, indent=2).encode()

        line = next(
            i for i, value in enumerate(
                self.raw.decode().splitlines(), 1
            )
            if '"' + self.path + '"' in value
        )

        raw_line = self.raw.decode().splitlines()[line - 1]
        self.start = raw_line.index('"') + 2
        self.end = len(raw_line) + 1
        self.entries = {line: (self.start, self.end, self.path)}

        self.finding = {
            "RuleID": "generic-api-key",
            "Commit": s._CHECKPOINT_COMMIT,
            "File": s._CHECKPOINT_PATH,
            "StartLine": line,
            "EndLine": line,
            "StartColumn": self.start,
            "EndColumn": self.end,
            "Secret": "REDACTED",
            "Fingerprint": "checkpoint-fixture",
        }

    def evaluate(self, finding=None, content=None, extra=()):
        if finding is None:
            finding = self.finding

        if content is None:
            content = self.content

        def fake_blob(commit, path):
            if path == s._CHECKPOINT_PATH:
                return self.raw
            if path == self.path:
                return content
            raise ValueError("unexpected path")

        with patch.object(s, "_CHECKPOINT_ENTRIES", self.entries), \
             patch.object(s, "_checkpoint_blob", side_effect=fake_blob):

            return s.qualify(
                [finding, *extra], 42,
                raw_report_sha256=REPORT_SHA,
                read_line=lambda _: "",
            )

    def test_exact_checksum_proof(self):
        result = self.evaluate()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["verified_public_references"], 0)
        self.assertEqual(result["verified_source_hashes"], 1)
        self.assertEqual(result["raw_findings"], 1)
        self.assertEqual(result["unresolved_findings"], 0)

    def test_modified_source_remains_blocked(self):
        result = self.evaluate(content=b"modified source")
        self.assertEqual(result["status"], "BLOCKED")

    def test_wrong_commit_path_rule_or_coordinates_blocked(self):
        for key, value in (
            ("Commit", "b" * 40),
            ("File", "other.json"),
            ("RuleID", "github-pat"),
            ("StartColumn", self.start + 1),
            ("EndColumn", self.end + 1),
            ("StartLine", 100),
        ):
            finding = dict(self.finding)
            finding[key] = value
            if key == 'StartLine':
                finding['EndLine'] = value

            with self.subTest(key=key):
                self.assertEqual(
                    self.evaluate(finding)["status"],
                    "BLOCKED",
                )

    def test_other_unresolved_findings_still_block(self):
        other = dict(
            self.finding,
            Fingerprint="other-fixture",
            RuleID="github-pat",
        )

        result = self.evaluate(extra=(other,))

        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(result["raw_findings"], 2)
        self.assertEqual(result["verified_source_hashes"], 1)
        self.assertEqual(result["unresolved_findings"], 1)





    def test_same_coordinates_different_fingerprint_rejected(self):
        duplicate = dict(
            self.finding, Fingerprint="different-fingerprint"
        )
        with self.assertRaises(ValueError):
            self.evaluate(extra=(duplicate,))

    def test_duplicate_fingerprint_rejected(self):
        other = dict(self.finding, RuleID="github-pat")
        with self.assertRaises(ValueError):
            self.evaluate(extra=(other,))

    def test_malformed_and_missing_coordinates_rejected(self):
        keys = (
            "StartLine", "EndLine", "StartColumn", "EndColumn",
        )

        for key in keys:
            for value in (
                float(self.finding[key]),
                True, None, "1", 0, -1,
            ):
                with self.subTest(key=key, value=value):
                    finding = dict(self.finding)
                    finding[key] = value
                    with self.assertRaises(ValueError):
                        self.evaluate(finding)

            missing = dict(self.finding)
            missing.pop(key)

            with self.subTest(missing=key):
                with self.assertRaises(ValueError):
                    self.evaluate(missing)

    def test_digest_outside_finding_span_blocks(self):
        number = self.finding["StartLine"]
        line = self.raw.decode().splitlines()[number - 1]
        short_end = line.index('":') + 2

        finding = dict(self.finding, EndColumn=short_end)

        self.entries = {
            number: (self.start, short_end, self.path),
        }

        result = self.evaluate(finding)

        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(result["verified_source_hashes"], 0)


class StrictScannerReportTests(unittest.TestCase):

    def test_duplicate_keys_and_invalid_constants(self):
        cases = (
            b'{"a":1,"a":2}',
            b'[{"outer":{"a":1,"a":2}}]',
            b'{"a":NaN}',
            b'{"a":Infinity}',
            b'{"a":-Infinity}',
        )

        for raw in cases:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    s.strict_json(raw)

    def test_source_hash_counter_always_present(self):
        result = s.qualify([], 0)

        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["verified_source_hashes"], 0)
        self.assertEqual(result["unresolved_findings"], 0)

    def test_bool_and_float_exit_codes_rejected(self):
        for value in (False, True, 0.0, 42.0):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    s.qualify([], value)

    def test_cli_rejects_duplicate_json_keys(self):
        import tempfile

        with tempfile.TemporaryDirectory(
            prefix="hc-report-fixture-"
        ) as directory:
            report = Path(directory) / "report.json"
            output = Path(directory) / "classification.json"

            report.write_bytes(b'[{"RuleID":"a","RuleID":"b"}]')

            result = s.subprocess.run(
                [
                    s.sys.executable,
                    "-B",
                    str(Path(s.__file__).resolve()),
                    "--report", str(report),
                    "--scanner-exit", "42",
                    "--output", str(output),
                ],
                capture_output=True,
                timeout=30,
            )

            self.assertEqual(result.returncode, 1)

            evidence = json.loads(output.read_bytes())
            self.assertEqual(evidence["status"], "BLOCKED")
            self.assertIn("error", evidence)


class HistoricalGitObjectTests(unittest.TestCase):
    def setUp(self):
        import tempfile

        # Synthetic objects only; never a copy of HomeCloud.
        temp = tempfile.TemporaryDirectory(prefix="hc-proof-fixture-")
        self.addCleanup(temp.cleanup)
        self.repo = Path(temp.name)

        clean_env = {
            k: v for k, v in os.environ.items()
            if not k.startswith("GIT_")
        }
        environment = patch.dict(os.environ, clean_env, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

        old = Path.cwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, old)

        self.git("init", "--bare", "--object-format=sha1", "-q")

        self.source_path = "scripts/ci/fixture.py"
        self.content = b"original source fixture\n"

        self.commit, self.tree, self.blob = self.make_commit(
            self.source_path, self.content
        )

        document = {
            "ci": {
                "actual_wave2_collector": {
                    "pair_manifest": {
                        "commit": self.commit,
                        "source_files": {
                            self.source_path:
                                hashlib.sha256(self.content).hexdigest(),
                        },
                    },
                },
            },
        }

        self.raw = json.dumps(document, indent=2).encode()

        self.checkpoint, _, self.checkpoint_blob = self.make_commit(
            s._CHECKPOINT_PATH, self.raw
        )

        number, line = next(
            (n, line)
            for n, line in enumerate(self.raw.decode().splitlines(), 1)
            if '"' + self.source_path + '"' in line
        )

        start = line.index('"') + 2
        end = len(line) + 1

        self.entries = {
            number: (start, end, self.source_path),
        }

        self.finding = dict(
            RuleID="generic-api-key",
            Commit=self.checkpoint,
            File=s._CHECKPOINT_PATH,
            Secret="REDACTED",
            Fingerprint="synthetic-object-proof",
            StartLine=number,
            EndLine=number,
            StartColumn=start,
            EndColumn=end,
        )

    def git(self, *args, data=None):
        return s.subprocess.check_output(
            ["git", "-C", str(self.repo), *args],
            input=data,
            stderr=s.subprocess.PIPE,
        )

    def object(self, kind, data):
        return self.git(
            "hash-object", "-w", "-t", kind, "--stdin",
            data=data,
        ).decode().strip()

    def make_commit(self, path, data):
        blob = self.object("blob", data)
        oid, mode = blob, b"100644"

        for part in reversed(path.split("/")):
            raw = (
                mode + b" " + part.encode() + b"\0"
                + bytes.fromhex(oid)
            )
            oid = self.object("tree", raw)
            mode = b"40000"

        tree = oid

        payload = (
            b"tree " + tree.encode() + b"\n"
            b"author Fixture <fixture@example.invalid> 0 +0000\n"
            b"committer Fixture <fixture@example.invalid> 0 +0000\n"
            b"\nsynthetic fixture\n"
        )

        return self.object("commit", payload), tree, blob

    def loose(self, oid):
        return self.repo / "objects" / oid[:2] / oid[2:]

    def corrupt(self, oid, kind, data):
        import zlib

        path = self.loose(oid)
        self.assertTrue(path.is_file())
        path.chmod(0o600)

        header = (
            kind.encode() + b" "
            + str(len(data)).encode() + b"\0"
        )

        path.write_bytes(zlib.compress(header + data))

    def classify(self):
        with patch.object(s, "_CHECKPOINT_COMMIT", self.checkpoint), \
             patch.object(s, "_CHECKPOINT_SOURCE_COMMIT", self.commit), \
             patch.object(s, "_CHECKPOINT_ENTRIES", self.entries):
            return s.qualify(
                [self.finding], 42,
                raw_report_sha256=REPORT_SHA,
            )["status"]

    def test_real_git_object_chain(self):
        self.assertEqual(
            s._checkpoint_blob(self.commit, self.source_path),
            self.content,
        )
        self.assertEqual(self.classify(), "PASS")

    def test_corrupted_blob_blocks(self):
        self.corrupt(self.blob, "blob", b"wrong contents\n")
        self.assertEqual(self.classify(), "BLOCKED")

    def test_corrupted_commit_blocks(self):
        raw = self.git("cat-file", "commit", self.commit)
        self.corrupt(self.commit, "commit", raw + b"changed\n")
        self.assertEqual(self.classify(), "BLOCKED")

    def test_corrupted_tree_blocks(self):
        raw = self.git("cat-file", "tree", self.tree)
        replacement = self.object("tree", b"")
        tampered = raw[:-20] + bytes.fromhex(replacement)

        self.corrupt(self.tree, "tree", tampered)
        self.assertEqual(self.classify(), "BLOCKED")

    def test_coordinated_substitution_blocks(self):
        replacement = b"coordinated replacement source\n"

        old = hashlib.sha256(self.content).hexdigest().encode()
        new = hashlib.sha256(replacement).hexdigest().encode()

        self.assertIn(old, self.raw)

        self.corrupt(self.blob, "blob", replacement)
        self.corrupt(
            self.checkpoint_blob,
            "blob",
            self.raw.replace(old, new),
        )

        self.assertEqual(self.classify(), "BLOCKED")

    def test_missing_object_blocks(self):
        self.loose(self.blob).unlink()
        self.assertEqual(self.classify(), "BLOCKED")

    def test_replace_ref_cannot_change_proof(self):
        replacement = self.object("blob", b"replacement\n")
        self.git("replace", self.blob, replacement)

        self.assertEqual(
            s._checkpoint_blob(self.commit, self.source_path),
            self.content,
        )
        self.assertEqual(self.classify(), "PASS")


if __name__=='__main__':
    unittest.main()
