import contextvars
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from .. import audit as audit_mod
from ..config import get_settings
from ..email_backend import send_email
from ..errors import Conflict, Gone, NotFound, RateLimited, Unauthorized
from ..models import Token, User
from ..security import hash_secret, new_id, new_opaque_token, utcnow
from .webhook_service import emit

settings = get_settings()


def get_user_by_email(db: Session, email: str) -> User | None:
    return db.query(User).filter(User.email == email.lower()).one_or_none()


def get_user(db: Session, user_id: str) -> User:
    user = db.get(User, user_id)
    if not user:
        raise NotFound("user not found")
    return user


def _issue_token(db: Session, user: User, purpose: str, ttl) -> str:
    raw = new_opaque_token()
    db.add(
        Token(
            id=new_id(),
            user_id=user.id,
            purpose=purpose,
            token_hash=hash_secret(raw),
            expires_at=utcnow() + ttl,
        )
    )
    return raw


def register(db: Session, email: str, display_name: str | None, timezone: str | None) -> User:
    email = email.lower()
    existing = get_user_by_email(db, email)
    if existing and existing.verified:
        raise Conflict("email already registered")
    user = existing or User(id=new_id(), email=email)
    user.display_name = display_name or user.display_name
    user.timezone = timezone or user.timezone
    db.add(user)
    db.flush()
    token = _issue_token(db, user, "verify_email", timedelta(hours=settings.verify_token_ttl_hours))
    send_email(email, "Verify your 4Seas account", "Verify: /v1/auth/verify-email token=" + token)
    audit_mod.audit(db, "system", None, "auth.register", {"user_id": user.id})
    db.commit()
    db.refresh(user)
    return user


def _consume_token(db: Session, raw: str, purpose: str) -> User:
    token = db.query(Token).filter(Token.token_hash == hash_secret(raw), Token.purpose == purpose).one_or_none()
    if not token:
        raise Unauthorized("invalid token")
    if token.consumed_at is not None:
        raise Unauthorized("token already used")
    if token.expires_at < utcnow():
        raise Gone("token expired")
    token.consumed_at = utcnow()
    user = db.get(User, token.user_id)
    db.flush()
    return user


def verify_email(db: Session, token: str) -> User:
    user = _consume_token(db, token, "verify_email")
    user.verified = True
    audit_mod.audit(db, "system", None, "auth.verify_email", {"user_id": user.id})
    db.commit()
    db.refresh(user)
    emit(db, "user.verified", {"user_id": user.id, "email": user.email})
    db.commit()
    return user


def request_passcode(db: Session, email: str) -> None:
    """Email a 6-digit code. Unknown or unverified addresses get the same response."""
    email = email.lower()
    user = get_user_by_email(db, email)
    if user and user.verified:
        latest = (
            db.query(Token)
            .filter(Token.user_id == user.id, Token.purpose == "passcode")
            .order_by(Token.created_at.desc())
            .first()
        )
        if not latest or latest.created_at < utcnow() - timedelta(seconds=30):
            now = utcnow()
            db.query(Token).filter(
                Token.user_id == user.id,
                Token.purpose == "passcode",
                Token.consumed_at.is_(None),
            ).update({Token.consumed_at: now}, synchronize_session=False)
            code = f"{__import__('secrets').randbelow(1000000):06d}"
            db.add(
                Token(
                    id=new_id(),
                    user_id=user.id,
                    purpose="passcode",
                    token_hash=hash_secret(f"{code}:{email}"),
                    expires_at=now + timedelta(minutes=settings.passcode_ttl_minutes),
                )
            )
            send_email(email, "Your 4Seas login code", "code=" + code)
    db.commit()


# Five wrong or expired codes in this window lock the address. Knowing the address is enough to trigger it.
PASSCODE_MAX_FAILURES = 5
PASSCODE_LOCK_MINUTES = 15
# Set to the reserved ticket before the code is read. 0 means this attempt has not reserved one.
_passcode_ticket: contextvars.ContextVar[int] = contextvars.ContextVar("passcode_ticket", default=0)
# expires_at on the meter row is METER_EPOCH plus the attempt number, in whole seconds.
METER_EPOCH = utcnow().replace(year=2020, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)


def _as_utc(value) -> datetime:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo is not None else value
    return datetime.fromisoformat(str(value).replace("Z", ""))


def _meter_ticket(expires_at) -> int:
    return int((_as_utc(expires_at) - METER_EPOCH).total_seconds())


def _load_passcode(db: Session, email: str, code: str) -> Token | None:
    return (
        db.query(Token)
        .filter(Token.token_hash == hash_secret(f"{code}:{email}"), Token.purpose == "passcode")
        .one_or_none()
    )


def _sqlite_immediate(db: Session, work):
    """Read and write the attempt meter with SQLite's reserved lock held the whole time."""
    db.commit()
    raw_conn = db.get_bind().raw_connection()
    try:
        dbapi = raw_conn.driver_connection
        previous = dbapi.isolation_level
        dbapi.isolation_level = None
        try:
            dbapi.execute("BEGIN IMMEDIATE")
            cursor = dbapi.cursor()
            try:
                result = work(cursor)
                dbapi.commit()
                return result
            except Exception:
                dbapi.rollback()
                raise
            finally:
                cursor.close()
        finally:
            dbapi.isolation_level = previous
    finally:
        raw_conn.close()


def _reserve_passcode_attempt(db: Session, user_id: str) -> int:
    """Take the next attempt number under a write lock, before the code is read."""

    def work(cursor) -> int:
        now = utcnow()
        cursor.execute(
            "SELECT expires_at, created_at FROM tokens WHERE user_id = ? AND purpose = 'passcode_meter'",
            (user_id,),
        )
        row = cursor.fetchone()
        window_open = row is not None and _as_utc(row[1]) >= now - timedelta(minutes=PASSCODE_LOCK_MINUTES)
        if window_open:
            ticket = _meter_ticket(row[0]) + 1
            cursor.execute(
                "UPDATE tokens SET expires_at = ? WHERE user_id = ? AND purpose = 'passcode_meter'",
                (METER_EPOCH + timedelta(seconds=ticket), user_id),
            )
            return ticket
        ticket = 1
        exp = METER_EPOCH + timedelta(seconds=ticket)
        if row is None:
            cursor.execute(
                """INSERT INTO tokens (id, user_id, purpose, token_hash, expires_at, created_at)
                   VALUES (?, ?, 'passcode_meter', ?, ?, ?)""",
                (new_id(), user_id, hash_secret(f"passcode-meter:{user_id}"), exp, now),
            )
        else:
            cursor.execute(
                """UPDATE tokens SET expires_at = ?, created_at = ?
                   WHERE user_id = ? AND purpose = 'passcode_meter'""",
                (exp, now, user_id),
            )
        return ticket

    return _sqlite_immediate(db, work)


def _accept_passcode(db: Session, user_id: str, email: str, code: str, ticket: int) -> User:
    token = _load_passcode(db, email, code)
    if not token or token.consumed_at is not None:
        raise Unauthorized("invalid code")
    if token.expires_at < utcnow():
        raise Gone("code expired")
    token_id = token.id

    def work(cursor) -> None:
        now = utcnow()
        cursor.execute("UPDATE tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", (now, token_id))
        if cursor.rowcount != 1:
            raise Unauthorized("invalid code")
        cursor.execute(
            "SELECT expires_at FROM tokens WHERE user_id = ? AND purpose = 'passcode_meter'",
            (user_id,),
        )
        row = cursor.fetchone()
        # A later attempt already took a higher number. Leave that lock in place.
        if row is not None and _meter_ticket(row[0]) == ticket:
            cursor.execute(
                """UPDATE tokens SET expires_at = ?, created_at = ?
                   WHERE user_id = ? AND purpose = 'passcode_meter'""",
                (METER_EPOCH, now, user_id),
            )

    _sqlite_immediate(db, work)
    audit_mod.audit(db, "system", None, "auth.passcode", {"user_id": user_id})
    db.commit()
    fresh = db.get(User, user_id)
    if fresh is None:
        raise Unauthorized("invalid code")
    return fresh


def verify_passcode(db: Session, email: str, code: str) -> User:
    email = email.lower()
    code = code.strip()
    user = get_user_by_email(db, email)
    if not user or not user.verified or user.email != email:
        raise Unauthorized("invalid code")
    ticket = _reserve_passcode_attempt(db, user.id)
    _passcode_ticket.set(ticket)
    if ticket > PASSCODE_MAX_FAILURES:
        raise RateLimited("too many attempts")
    return _accept_passcode(db, user.id, email, code, ticket)


def request_login(db: Session, email: str) -> None:
    """Always succeeds from the caller's perspective (no account enumeration)."""
    email = email.lower()
    user = get_user_by_email(db, email)
    if user and user.verified:
        token = _issue_token(db, user, "login", timedelta(minutes=settings.login_token_ttl_minutes))
        send_email(email, "Your 4Seas login link", "Login: /v1/auth/login/verify token=" + token)
    db.commit()


def verify_login(db: Session, token: str) -> User:
    user = _consume_token(db, token, "login")
    if not user.verified:
        raise Unauthorized("email not verified")
    audit_mod.audit(db, "system", None, "auth.login", {"user_id": user.id})
    db.commit()
    db.refresh(user)
    return user
