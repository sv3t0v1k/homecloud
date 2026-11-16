"""Seed ordinary users in owned disposable runtime databases only.

No product endpoint or self-registration fallback.
The caller must own the newly created fixture container.
"""
import json
import pathlib
import re
import subprocess

BACKEND = pathlib.Path(__file__).resolve().parents[2] / "backend"

FIXTURES = {
    "hc_smoke": r"hc-failure-security-[a-f0-9]{12}",
    "hc_release": r"hc-release-drill-[a-f0-9]{12}",
    "hc_secrets": r"hc-secret-drill-[a-f0-9]{12}",
    "hc_tls": r"hc-tls-[a-f0-9]{10}-db",
    "qualification": r"hc-pair-[a-f0-9]{10}-db",
}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def execute(args, stdin=None, cwd=None):
    p = subprocess.run(
        args, input=stdin, cwd=cwd, text=True,
        capture_output=True, timeout=60,
    )
    require(p.returncode == 0, "Fixture subprocess failed")
    return p.stdout.strip()


def sql_text(value):
    return "convert_from(decode('" + value.encode("utf-8").hex() + "','hex'),'UTF8')"


def seed_fixture_user(container, database, credentials, *, quota=0, historical=False):
    pattern = FIXTURES.get(database)
    require(pattern and isinstance(container, str)
            and re.fullmatch(pattern, container),
            "Refusing non-fixture database target")
    require(type(quota) is int and 0 <= quota <= 1073741824,
            "Invalid fixture quota")
    require(type(historical) is bool
            and (not historical or database == "qualification"),
            "Invalid historical fixture mode")
    require(isinstance(credentials, dict)
            and set(credentials) == {"email", "password", "name"},
            "Invalid fixture credentials")

    email, password, name = (
        credentials[k] for k in ("email", "password", "name")
    )

    require(isinstance(email, str) and len(email) <= 255
            and re.fullmatch(r"[a-z0-9._+-]+@[a-z0-9.-]+\.(test|invalid)", email),
            "Invalid fixture email")
    require(isinstance(password, str)
            and 12 <= len(password.encode("utf-8")) <= 72
            and "\x00" not in password, "Invalid fixture password")
    require(isinstance(name, str) and 0 < len(name) <= 100
            and "\x00" not in name, "Invalid fixture name")

    inspected = json.loads(execute(
        ["docker", "inspect", "--type", "container", container]
    ))
    require(len(inspected) == 1, "Invalid container identity")

    info = inspected[0]
    config = info["Config"]
    container_id = info["Id"]

    require(info["Name"] == "/" + container
            and info["State"]["Running"] is True
            and re.fullmatch(r"[a-f0-9]{64}", container_id)
            and config["Image"] == "postgres:16-alpine",
            "Unexpected fixture container")

    environment = config.get("Env") or []

    require([v for v in environment if v.startswith("POSTGRES_DB=")]
            == ["POSTGRES_DB=" + database],
            "Unexpected fixture database")
    require([v for v in environment if v.startswith("POSTGRES_USER=")]
            in ([], ["POSTGRES_USER=postgres"]),
            "Unexpected fixture database user")

    program = """
const bcrypt = require("bcryptjs");
const password = require("node:fs").readFileSync(0, "utf8");
bcrypt.hash(password, 12)
  .then(value => process.stdout.write(value))
  .catch(() => process.exit(1));
"""
    password_hash = execute(
        ["node", "-e", program], stdin=password, cwd=BACKEND
    )

    require(re.fullmatch(r"\$2[aby]\$12\$[./A-Za-z0-9]{53}", password_hash),
            "Invalid bcrypt output")

    maximum_before = 1 if database == "hc_smoke" else 0
    legacy_allowed = "TRUE" if historical else "FALSE"

    statement = f"""
BEGIN;
DO $fixture$
DECLARE
    created jsonb;
BEGIN
    IF current_database() <> '{database}'
       OR current_user <> 'postgres'
       OR current_schema() <> 'public' THEN
        RAISE EXCEPTION 'Unexpected fixture database identity';
    END IF;

    LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;

    IF (SELECT count(*) FROM public.users) > {maximum_before} THEN
        RAISE EXCEPTION 'Fixture database is not fresh';
    END IF;

    INSERT INTO public.users AS u
        (email,password,name,"isActive","storageQuota","storageUsed")
    VALUES ({sql_text(email)}, {sql_text(password_hash)},
            {sql_text(name)}, TRUE, {quota}, 0)
    RETURNING to_jsonb(u) INTO created;

    IF (created ? 'role') AND (created ? 'sessionVersion') THEN
        IF created->>'role' IS DISTINCT FROM 'USER'
           OR created->>'sessionVersion' IS DISTINCT FROM '1' THEN
            RAISE EXCEPTION 'Unsafe current-schema defaults';
        END IF;
    ELSIF (created ? 'role')
       OR (created ? 'sessionVersion')
       OR NOT {legacy_allowed} THEN
        RAISE EXCEPTION 'Unexpected authorization schema';
    END IF;

    IF created->>'isActive' IS DISTINCT FROM 'true'
       OR created->>'storageQuota' IS DISTINCT FROM '{quota}'
       OR created->>'storageUsed' IS DISTINCT FROM '0' THEN
        RAISE EXCEPTION 'Unexpected fixture account state';
    END IF;
END
$fixture$;
COMMIT;
SELECT 'fixture-account-created';
"""

    result = execute([
        "docker", "exec", "-i", container_id,
        "psql", "-X", "-v", "ON_ERROR_STOP=1",
        "-U", "postgres", "-d", database, "-qAt",
    ], stdin=statement)

    require(result == "fixture-account-created",
            "Fixture transaction not confirmed")
