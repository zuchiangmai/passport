"""Google and GitHub sign-in. Both collapse to the same Passport user by verified email."""

from datetime import timedelta

import httpx
from sqlalchemy.orm import Session

from ..config import get_settings
from ..errors import Unauthorized, Unprocessable
from ..models import OAuthTransaction, User
from ..security import new_id, utcnow
from .auth_service import get_user_by_email
from .connect_service import authorize

settings = get_settings()


def provider_configured(provider: str) -> bool:
    if provider == "google":
        return bool(settings.google_client_id and settings.google_client_secret)
    if provider == "github":
        return bool(settings.github_client_id and settings.github_client_secret)
    return False


def callback_url(provider: str) -> str:
    base = settings.public_base_url.rstrip("/")
    return f"{base}/passport/v1/auth/{provider}/callback"


def start(db: Session, provider: str, client_id: str, redirect_uri: str, client_state: str) -> OAuthTransaction:
    from .connect_service import check_redirect

    check_redirect(client_id, redirect_uri)
    row = OAuthTransaction(
        id=new_id(),
        provider=provider,
        client_id=client_id,
        redirect_uri=redirect_uri,
        client_state=client_state,
        expires_at=utcnow() + timedelta(minutes=10),
    )
    db.add(row)
    db.commit()
    return row


def take(db: Session, provider: str, tx_id: str) -> OAuthTransaction:
    row = db.get(OAuthTransaction, tx_id)
    if not row or row.provider != provider:
        raise Unauthorized("oauth state not found")
    if row.consumed_at is not None:
        raise Unauthorized("oauth state already used")
    if row.expires_at < utcnow():
        raise Unauthorized("oauth state expired")
    row.consumed_at = utcnow()
    db.commit()
    return row


def upsert_verified_email(db: Session, email: str, display_name: str | None) -> User:
    email = email.lower()
    user = get_user_by_email(db, email)
    if not user:
        user = User(id=new_id(), email=email, verified=True, display_name=display_name, created_at=utcnow(), updated_at=utcnow())
        db.add(user)
    else:
        user.verified = True
        if display_name and not user.display_name:
            user.display_name = display_name
    db.commit()
    db.refresh(user)
    return user


def finish(db: Session, tx: OAuthTransaction, user: User) -> str:
    granted = authorize(db, user, tx.client_id, tx.redirect_uri, tx.client_state)
    return granted["redirect_to"]


def exchange_google(code: str) -> dict:
    redirect = callback_url("google")
    token_res = httpx.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "redirect_uri": redirect,
            "grant_type": "authorization_code",
        },
        timeout=10,
    )
    if token_res.status_code != 200:
        raise Unauthorized("google token exchange failed")
    access = token_res.json().get("access_token")
    user_res = httpx.get(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        headers={"Authorization": f"Bearer {access}"},
        timeout=10,
    )
    if user_res.status_code != 200:
        raise Unauthorized("google userinfo failed")
    info = user_res.json()
    if not info.get("email") or not info.get("email_verified"):
        raise Unprocessable("google account has no verified email")
    return {"email": info["email"], "display_name": info.get("name")}


def exchange_github(code: str) -> dict:
    token_res = httpx.post(
        "https://github.com/login/oauth/access_token",
        data={
            "code": code,
            "client_id": settings.github_client_id,
            "client_secret": settings.github_client_secret,
        },
        headers={"Accept": "application/json"},
        timeout=10,
    )
    if token_res.status_code != 200:
        raise Unauthorized("github token exchange failed")
    access = token_res.json().get("access_token")
    emails_res = httpx.get(
        "https://api.github.com/user/emails",
        headers={"Authorization": f"Bearer {access}", "Accept": "application/vnd.github+json", "User-Agent": "4seas-passport"},
        timeout=10,
    )
    if emails_res.status_code != 200:
        raise Unauthorized("github emails failed")
    verified = [row for row in emails_res.json() if row.get("verified") and row.get("email")]
    primary = next((row for row in verified if row.get("primary")), None) or (verified[0] if verified else None)
    if not primary:
        raise Unprocessable("github account has no verified email")
    user_res = httpx.get(
        "https://api.github.com/user",
        headers={"Authorization": f"Bearer {access}", "Accept": "application/vnd.github+json", "User-Agent": "4seas-passport"},
        timeout=10,
    )
    name = user_res.json().get("name") if user_res.status_code == 200 else None
    return {"email": primary["email"], "display_name": name}
