from urllib.parse import urlencode

from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import AppError, Unprocessable
from ..services import connect_service, oauth_providers

router = APIRouter(prefix="/v1/auth", tags=["oauth"])


def _start(provider: str, client_id: str, redirect_uri: str, state: str, db: Session) -> RedirectResponse:
    if not oauth_providers.provider_configured(provider):
        raise Unprocessable(f"{provider} is not configured")
    connect_service.check_redirect(client_id, redirect_uri)
    tx = oauth_providers.start(db, provider, client_id, redirect_uri, state)
    if provider == "google":
        params = urlencode(
            {
                "client_id": oauth_providers.settings.google_client_id,
                "redirect_uri": oauth_providers.callback_url("google"),
                "response_type": "code",
                "scope": "openid email profile",
                "state": tx.id,
            }
        )
        url = "https://accounts.google.com/o/oauth2/v2/auth?" + params
    else:
        params = urlencode(
            {
                "client_id": oauth_providers.settings.github_client_id,
                "redirect_uri": oauth_providers.callback_url("github"),
                "scope": "read:user user:email",
                "state": tx.id,
            }
        )
        url = "https://github.com/login/oauth/authorize?" + params
    return RedirectResponse(url, status_code=302)


def _callback(provider: str, code: str | None, state: str | None, db: Session) -> RedirectResponse:
    if not code or not state:
        raise Unprocessable("missing oauth code")
    tx = oauth_providers.take(db, provider, state)
    try:
        profile = oauth_providers.exchange_google(code) if provider == "google" else oauth_providers.exchange_github(code)
        user = oauth_providers.upsert_verified_email(db, profile["email"], profile.get("display_name"))
        return RedirectResponse(oauth_providers.finish(db, tx, user), status_code=302)
    except AppError as exc:
        query = urlencode({"error": exc.code, "state": tx.client_state})
        return RedirectResponse(f"{tx.redirect_uri}?{query}", status_code=302)


@router.get("/google/start")
def google_start(client_id: str, redirect_uri: str, state: str, db: Session = Depends(get_db)):
    return _start("google", client_id, redirect_uri, state, db)


@router.get("/google/callback")
def google_callback(code: str | None = None, state: str | None = None, db: Session = Depends(get_db)):
    return _callback("google", code, state, db)


@router.get("/github/start")
def github_start(client_id: str, redirect_uri: str, state: str, db: Session = Depends(get_db)):
    return _start("github", client_id, redirect_uri, state, db)


@router.get("/github/callback")
def github_callback(code: str | None = None, state: str | None = None, db: Session = Depends(get_db)):
    return _callback("github", code, state, db)
