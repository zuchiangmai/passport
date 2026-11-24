from datetime import timedelta

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


def _record_passcode_failure(db: Session, user: User) -> None:
    db.add(
        Token(
            id=new_id(),
            user_id=user.id,
            purpose="passcode_fail",
            token_hash=hash_secret(new_opaque_token()),
            expires_at=utcnow() + timedelta(minutes=PASSCODE_LOCK_MINUTES),
        )
    )
    db.commit()


def _passcode_failures(db: Session, user: User) -> int:
    since = utcnow() - timedelta(minutes=PASSCODE_LOCK_MINUTES)
    return (
        db.query(Token)
        .filter(
            Token.user_id == user.id,
            Token.purpose == "passcode_fail",
            Token.created_at >= since,
        )
        .count()
    )


def _reject_passcode(db: Session, user: User, *, expired: bool) -> None:
    """Commit the failure before deciding, so concurrent guesses cannot all pass the old count."""
    _record_passcode_failure(db, user)
    if _passcode_failures(db, user) > PASSCODE_MAX_FAILURES:
        raise RateLimited("too many attempts")
    if expired:
        raise Gone("code expired")
    raise Unauthorized("invalid code")


def verify_passcode(db: Session, email: str, code: str) -> User:
    email = email.lower()
    code = code.strip()
    user = get_user_by_email(db, email)
    if user and user.verified and _passcode_failures(db, user) >= PASSCODE_MAX_FAILURES:
        raise RateLimited("too many attempts")
    token = (
        db.query(Token)
        .filter(Token.token_hash == hash_secret(f"{code}:{email}"), Token.purpose == "passcode")
        .one_or_none()
    )
    if not token or token.consumed_at is not None or not user or user.email != email or not user.verified:
        if user and user.verified:
            _reject_passcode(db, user, expired=False)
        raise Unauthorized("invalid code")
    if token.expires_at < utcnow():
        _reject_passcode(db, user, expired=True)
    if _passcode_failures(db, user) >= PASSCODE_MAX_FAILURES:
        raise RateLimited("too many attempts")
    token.consumed_at = utcnow()
    db.query(Token).filter(Token.user_id == user.id, Token.purpose == "passcode_fail").delete()
    audit_mod.audit(db, "system", None, "auth.passcode", {"user_id": user.id})
    db.commit()
    db.refresh(user)
    return user


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
