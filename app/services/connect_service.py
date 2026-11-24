"""Authorization code handoff from Passport to CoLiving and the canteen."""

import hmac
from datetime import timedelta
from urllib.parse import urlencode

from sqlalchemy.orm import Session

from .. import audit as audit_mod
from ..config import get_settings
from ..errors import CanteenRequiresColiving, Forbidden, Gone, Unauthorized
from ..models import AuthCode, User
from ..security import hash_secret, new_id, new_opaque_token, utcnow
from .identity_service import has_coliving, snapshot

settings = get_settings()

# Exact redirect URIs. Canteen is moving onto 4seas.xyz/canteen; the workers.dev
# host is the current deployment and is allowed until that cutover.
CLIENTS = {
    "coliving": {
        "secret_attr": "coliving_client_secret",
        "redirects": ("https://4seas.xyz/coliving/auth/callback",),
    },
    "canteen": {
        "secret_attr": "canteen_client_secret",
        "redirects": (
            "https://4seas.xyz/canteen/auth/callback",
            "https://healthyliving-admin.jhfnetboy.workers.dev/auth/callback",
        ),
    },
}


def _client(client_id: str) -> dict:
    client = CLIENTS.get(client_id)
    if not client:
        raise Forbidden("unknown client")
    return client


def check_redirect(client_id: str, redirect_uri: str) -> None:
    if redirect_uri not in _client(client_id)["redirects"]:
        raise Forbidden("redirect_uri is not registered")


def authorize(db: Session, user: User, client_id: str, redirect_uri: str, state: str) -> dict:
    check_redirect(client_id, redirect_uri)
    if client_id == "canteen" and not has_coliving(db, user.id):
        raise CanteenRequiresColiving("canteen requires a CoLiving registration")
    raw = new_opaque_token()
    db.add(
        AuthCode(
            id=new_id(),
            user_id=user.id,
            client_id=client_id,
            redirect_uri=redirect_uri,
            code_hash=hash_secret(raw),
            expires_at=utcnow() + timedelta(minutes=settings.auth_code_ttl_minutes),
        )
    )
    audit_mod.audit(db, "user", user.id, "connect.authorize", {"client_id": client_id})
    db.commit()
    query = urlencode({"code": raw, "state": state})
    return {"code": raw, "redirect_to": f"{redirect_uri}?{query}", "sub": user.id}


def exchange(db: Session, client_id: str, client_secret: str, code: str, redirect_uri: str) -> dict:
    client = _client(client_id)
    expected = getattr(settings, client["secret_attr"])
    if not client_secret or not hmac.compare_digest(client_secret, expected):
        raise Unauthorized("invalid client")
    check_redirect(client_id, redirect_uri)
    row = db.query(AuthCode).filter(AuthCode.code_hash == hash_secret(code)).one_or_none()
    if not row or row.client_id != client_id or row.redirect_uri != redirect_uri:
        raise Unauthorized("invalid code")
    if row.consumed_at is not None:
        raise Unauthorized("code already used")
    if row.expires_at < utcnow():
        raise Gone("code expired")
    row.consumed_at = utcnow()
    user = db.get(User, row.user_id)
    if not user:
        raise Unauthorized("invalid code")
    if client_id == "canteen" and not has_coliving(db, user.id):
        raise CanteenRequiresColiving("canteen requires a CoLiving registration")
    audit_mod.audit(db, "user", user.id, "connect.exchange", {"client_id": client_id})
    db.commit()
    body = snapshot(db, user)
    from ..security import create_access_token

    body["access_token"] = create_access_token(user.id)
    body["token_type"] = "Bearer"
    body["expires_in"] = settings.access_token_ttl_minutes * 60
    return body
