import random
import threading
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from app.db import Base
from app.errors import RateLimited, Unauthorized
from app.models import Token, User
from app.security import utcnow
from app.services import auth_service
from app.services.connect_service import client_secret_ok
from tests.test_auth import register_and_verify
from tests.test_service_keys import create_service_key

COLIVING = "https://4seas.xyz/coliving/auth/callback"
CANTEEN = "https://4seas.xyz/canteen/auth/callback"


def unique_email():
    return "sub-" + uuid.uuid4().hex[:8] + "@example.com"


def passcode_login(client, mail, email):
    assert client.post("/v1/auth/passcode/request", json={"email": email}).status_code == 202
    code = mail.last_code(email)
    r = client.post("/v1/auth/passcode/verify", json={"email": email, "code": code})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["sub"] == body["user"]["user_id"]
    return body["access_token"], body["user"]["sub"]


def test_passcode_under_passport_prefix(client, mail):
    email = register_and_verify(client, mail)
    assert client.post("/passport/v1/auth/passcode/request", json={"email": email}).status_code == 202
    code = mail.last_code(email)
    r = client.post("/passport/v1/auth/passcode/verify", json={"email": email, "code": code})
    assert r.status_code == 200
    assert r.json()["user"]["sub"]


def test_passcode_is_single_use(client, mail):
    email = register_and_verify(client, mail)
    client.post("/v1/auth/passcode/request", json={"email": email})
    code = mail.last_code(email)
    assert client.post("/v1/auth/passcode/verify", json={"email": email, "code": code}).status_code == 200
    again = client.post("/v1/auth/passcode/verify", json={"email": email, "code": code})
    assert again.status_code == 401


def test_canteen_blocked_until_coliving_links(client, mail):
    email = register_and_verify(client, mail)
    token, sub = passcode_login(client, mail, email)
    r = client.post(
        "/v1/connect/authorize",
        json={"client_id": "canteen", "redirect_uri": CANTEEN, "state": "s1"},
        headers={"Authorization": "Bearer " + token},
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "canteen_requires_coliving"

    secret = create_service_key(client, ["identity:write", "identity:read"])
    linked = client.post(
        "/v1/identity/links",
        json={"app": "coliving", "email": email, "external_id": "cid-" + sub[:8], "display_name": "Resident"},
        headers={"X-Service-Key": secret},
    )
    assert linked.status_code == 200, linked.text
    assert linked.json()["sub"] == sub
    assert linked.json()["canteen_allowed"] is True

    r = client.post(
        "/v1/connect/authorize",
        json={"client_id": "canteen", "redirect_uri": CANTEEN, "state": "s2"},
        headers={"Authorization": "Bearer " + token},
    )
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    exchanged = client.post(
        "/v1/connect/token",
        json={
            "client_id": "canteen",
            "client_secret": "dev-canteen-secret",
            "code": code,
            "redirect_uri": CANTEEN,
        },
    )
    assert exchanged.status_code == 200, exchanged.text
    assert exchanged.json()["sub"] == sub
    assert exchanged.json()["canteen_allowed"] is True
    assert client.post(
        "/v1/connect/token",
        json={
            "client_id": "canteen",
            "client_secret": "dev-canteen-secret",
            "code": code,
            "redirect_uri": CANTEEN,
        },
    ).status_code == 401


def test_canteen_link_without_coliving_rejected(client, mail):
    email = unique_email()
    secret = create_service_key(client, ["identity:write"])
    r = client.post(
        "/v1/identity/links",
        json={"app": "canteen", "email": email, "external_id": "user-1"},
        headers={"X-Service-Key": secret},
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "canteen_requires_coliving"


def test_coliving_can_authorize(client, mail):
    email = register_and_verify(client, mail)
    token, sub = passcode_login(client, mail, email)
    r = client.post(
        "/v1/connect/authorize",
        json={"client_id": "coliving", "redirect_uri": COLIVING, "state": "abc"},
        headers={"Authorization": "Bearer " + token},
    )
    assert r.status_code == 200
    assert r.json()["redirect_to"].startswith(COLIVING + "?code=")
    exchanged = client.post(
        "/passport/v1/connect/token",
        json={
            "client_id": "coliving",
            "client_secret": "dev-coliving-secret",
            "code": r.json()["code"],
            "redirect_uri": COLIVING,
        },
    )
    assert exchanged.status_code == 200
    assert exchanged.json()["sub"] == sub
    assert exchanged.json()["canteen_allowed"] is False


def test_exchange_returns_snapshot_without_session_token(client, mail):
    email = register_and_verify(client, mail)
    token, sub = passcode_login(client, mail, email)
    r = client.post(
        "/v1/connect/authorize",
        json={"client_id": "coliving", "redirect_uri": COLIVING, "state": "abc"},
        headers={"Authorization": "Bearer " + token},
    )
    exchanged = client.post(
        "/v1/connect/token",
        json={
            "client_id": "coliving",
            "client_secret": "dev-coliving-secret",
            "code": r.json()["code"],
            "redirect_uri": COLIVING,
        },
    )
    assert exchanged.status_code == 200, exchanged.text
    body = exchanged.json()
    assert body["sub"] == sub
    assert "access_token" not in body
    assert "token_type" not in body


def test_passcode_locks_after_five_failures(client, mail):
    email = register_and_verify(client, mail)
    assert client.post("/v1/auth/passcode/request", json={"email": email}).status_code == 202
    code = mail.last_code(email)
    for _ in range(5):
        wrong = client.post("/v1/auth/passcode/verify", json={"email": email, "code": "000000"})
        assert wrong.status_code == 401
    locked = client.post("/v1/auth/passcode/verify", json={"email": email, "code": code})
    assert locked.status_code == 429
    assert locked.json()["error"]["code"] == "rate_limited"


def test_expired_passcode_counts_toward_lock(client, mail, db):
    email = register_and_verify(client, mail)
    assert client.post("/v1/auth/passcode/request", json={"email": email}).status_code == 202
    code = mail.last_code(email)
    user = db.query(User).filter(User.email == email).one()
    row = db.query(Token).filter(Token.user_id == user.id, Token.purpose == "passcode").one()
    row.expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    expired = client.post("/v1/auth/passcode/verify", json={"email": email, "code": code})
    assert expired.status_code == 410
    for _ in range(4):
        wrong = client.post("/v1/auth/passcode/verify", json={"email": email, "code": "000000"})
        assert wrong.status_code == 401
    locked = client.post("/v1/auth/passcode/verify", json={"email": email, "code": "000000"})
    assert locked.status_code == 429


def test_new_passcode_invalidates_the_previous_code(client, mail, db):
    email = register_and_verify(client, mail)
    assert client.post("/v1/auth/passcode/request", json={"email": email}).status_code == 202
    first = mail.last_code(email)
    user = db.query(User).filter(User.email == email).one()
    row = db.query(Token).filter(Token.user_id == user.id, Token.purpose == "passcode").one()
    row.created_at = utcnow() - timedelta(seconds=31)
    db.commit()
    assert client.post("/v1/auth/passcode/request", json={"email": email}).status_code == 202
    second = mail.last_code(email)
    assert second != first
    old = client.post("/v1/auth/passcode/verify", json={"email": email, "code": first})
    assert old.status_code == 401
    new = client.post("/v1/auth/passcode/verify", json={"email": email, "code": second})
    assert new.status_code == 200


def test_concurrent_wrong_codes_cannot_pass_the_lock(tmp_path, monkeypatch):
    """File sqlite, one connection per thread. The real code sits in the burst, not after it."""
    engine = create_engine(
        f"sqlite:///{tmp_path / 'lock.sqlite'}",
        connect_args={"check_same_thread": False, "timeout": 30},
        poolclass=NullPool,
    )

    @event.listens_for(engine, "connect")
    def _busy_timeout(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()

    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    sent = {}
    compared = []
    reserved = []
    compared_lock = threading.Lock()
    original_load = auth_service._load_passcode
    original_reserve = auth_service._reserve_passcode_attempt

    def capture(_to, _subject, body):
        sent["code"] = body.split("code=", 1)[1].split()[0]

    def counting_load(db, email, code):
        # Read in the verify thread. A compare that skipped the reserve still sees the default 0.
        ticket = auth_service._passcode_ticket.get()
        with compared_lock:
            compared.append((ticket, code))
        return original_load(db, email, code)

    def counting_reserve(db, user_id):
        ticket = original_reserve(db, user_id)
        with compared_lock:
            reserved.append(ticket)
        return ticket

    monkeypatch.setattr(auth_service, "send_email", capture)
    monkeypatch.setattr(auth_service, "_load_passcode", counting_load)
    monkeypatch.setattr(auth_service, "_reserve_passcode_attempt", counting_reserve)

    def reservations_are_one_lock(tickets: list[int]) -> bool:
        """One write lock: 1..N once, then at most one fresh window 1..M after the success reset."""
        if not tickets or any(t < 1 for t in tickets):
            return False
        counts = Counter(tickets)
        if any(n > 2 for n in counts.values()):
            return False
        hi = max(counts)
        if any(t not in counts for t in range(1, hi + 1)):
            return False
        doubled = {t for t, n in counts.items() if n == 2}
        if not doubled:
            return all(counts[t] == 1 for t in range(1, hi + 1))
        end = max(doubled)
        return doubled == set(range(1, end + 1))

    def burst(put_real_code_first: bool):
        compared.clear()
        reserved.clear()
        email = unique_email()
        setup = Session()
        try:
            setup.add(User(id=uuid.uuid4().hex, email=email, verified=True))
            setup.commit()
            auth_service.request_passcode(setup, email)
        finally:
            setup.close()
        real = sent["code"]
        guesses = ["000000"] * 40
        slot = 0 if put_real_code_first else random.randrange(len(guesses) + 1)
        guesses.insert(slot, real)

        def guess(attempt: str):
            one = Session()
            try:
                try:
                    auth_service.verify_passcode(one, email, attempt)
                except RateLimited:
                    return 429
                except Unauthorized:
                    return 401
                return 200
            finally:
                one.close()

        with ThreadPoolExecutor(max_workers=8) as pool:
            statuses = list(pool.map(guess, guesses))
        tickets = [ticket for ticket, _code in compared]
        real_hits = [ticket for ticket, code in compared if code == real]
        assert tickets and all(1 <= ticket <= 5 for ticket in tickets), (tickets, statuses)
        assert Counter(tickets) == Counter(ticket for ticket in reserved if ticket <= 5), (tickets, reserved)
        assert reservations_are_one_lock(reserved), (reserved, statuses)
        assert len(real_hits) <= 1, (real_hits, statuses)
        assert statuses.count(200) <= 1
        if statuses.count(200) == 1:
            assert len(real_hits) == 1 and real_hits[0] <= 5, (real_hits, statuses)
        assert set(statuses) <= {200, 401, 429}, statuses

    try:
        burst(True)
        for _ in range(7):
            burst(False)
    finally:
        engine.dispose()


def test_blank_client_secret_never_matches(client, mail, monkeypatch):
    assert client_secret_ok("", "") is False
    assert client_secret_ok("dev-coliving-secret", "") is False
    assert client_secret_ok("dev-coliving-secret", "dev-coliving-secret") is True
    email = register_and_verify(client, mail)
    token, _sub = passcode_login(client, mail, email)
    issued = client.post(
        "/v1/connect/authorize",
        json={"client_id": "coliving", "redirect_uri": COLIVING, "state": "blank"},
        headers={"Authorization": "Bearer " + token},
    )
    from app.services import connect_service

    monkeypatch.setattr(connect_service.settings, "coliving_client_secret", "")
    exchanged = client.post(
        "/v1/connect/token",
        json={
            "client_id": "coliving",
            "client_secret": "dev-coliving-secret",
            "code": issued.json()["code"],
            "redirect_uri": COLIVING,
        },
    )
    assert exchanged.status_code == 401


def test_production_rejects_published_client_secrets():
    from app.config import Settings, assert_client_secrets

    published = Settings(
        environment="production",
        coliving_client_secret="dev-coliving-secret",
        canteen_client_secret="a-real-canteen-secret",
    )
    try:
        assert_client_secrets(published)
    except RuntimeError as exc:
        assert "coliving_client_secret" in str(exc)
    else:
        raise AssertionError("published secret was accepted")

    empty = Settings(environment="production", coliving_client_secret="real-coliving", canteen_client_secret="")
    try:
        assert_client_secrets(empty)
    except RuntimeError as exc:
        assert "canteen_client_secret" in str(exc)
    else:
        raise AssertionError("empty secret was accepted")

    ok = Settings(
        environment="production",
        coliving_client_secret="real-coliving",
        canteen_client_secret="real-canteen",
    )
    assert_client_secrets(ok) is None

    spaced = Settings(
        environment=" Production ",
        coliving_client_secret=" dev-coliving-secret ",
        canteen_client_secret="real-canteen",
    )
    try:
        assert_client_secrets(spaced)
    except RuntimeError as exc:
        assert "coliving_client_secret" in str(exc)
    else:
        raise AssertionError("spaced published secret was accepted")

    change_me = Settings(
        environment="production",
        coliving_client_secret="real-coliving",
        canteen_client_secret="Change-me-canteen",
    )
    try:
        assert_client_secrets(change_me)
    except RuntimeError as exc:
        assert "canteen_client_secret" in str(exc)
    else:
        raise AssertionError("mixed-case change-me secret was accepted")


def test_bad_redirect_rejected(client, mail):
    email = register_and_verify(client, mail)
    token, _sub = passcode_login(client, mail, email)
    r = client.post(
        "/v1/connect/authorize",
        json={"client_id": "coliving", "redirect_uri": "https://evil.example/cb", "state": "x"},
        headers={"Authorization": "Bearer " + token},
    )
    assert r.status_code == 403


def test_login_page_on_passport_path(client):
    r = client.get("/passport/login")
    assert r.status_code == 200
    assert "4Seas Passport" in r.text
    assert client.get("/passport/healthz").json()["status"] == "ok"


def test_google_callback_reuses_sub(client, mail, monkeypatch):
    email = register_and_verify(client, mail)
    _token, _sub = passcode_login(client, mail, email)
    secret = create_service_key(client, ["identity:write"])
    assert client.post(
        "/v1/identity/links",
        json={"app": "coliving", "email": email, "external_id": "cid-google"},
        headers={"X-Service-Key": secret},
    ).status_code == 200

    from app.services import oauth_providers

    monkeypatch.setattr(oauth_providers, "provider_configured", lambda _p: True)
    monkeypatch.setattr(oauth_providers, "exchange_google", lambda _code: {"email": email, "display_name": "Alice"})
    start = client.get(
        "/passport/v1/auth/google/start",
        params={"client_id": "canteen", "redirect_uri": CANTEEN, "state": "from-canteen"},
        follow_redirects=False,
    )
    assert start.status_code == 302
    state = start.headers["location"].split("state=")[1]
    back = client.get(
        "/passport/v1/auth/google/callback",
        params={"code": "google-code", "state": state},
        follow_redirects=False,
    )
    assert back.status_code == 302
    assert back.headers["location"].startswith(CANTEEN + "?code=")
    assert "state=from-canteen" in back.headers["location"]
