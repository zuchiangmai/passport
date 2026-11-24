from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_service
from ..services.auth_service import get_user
from ..services.identity_service import link_app, snapshot

router = APIRouter(prefix="/v1/identity", tags=["identity"])


class LinkIn(BaseModel):
    app: str
    email: EmailStr
    external_id: str
    display_name: str | None = None


@router.post("/links")
def create_link(
    body: LinkIn,
    db: Session = Depends(get_db),
    _: str = Depends(require_service({"identity:write"})),
):
    return link_app(db, app=body.app, email=body.email, external_id=body.external_id, display_name=body.display_name)


@router.get("/{sub}")
def read_sub(
    sub: str,
    db: Session = Depends(get_db),
    _: str = Depends(require_service({"identity:read"})),
):
    return snapshot(db, get_user(db, sub))
