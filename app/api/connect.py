from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from ..models import User
from ..services import connect_service

router = APIRouter(prefix="/v1/connect", tags=["connect"])


class AuthorizeIn(BaseModel):
    client_id: str
    redirect_uri: str
    state: str = Field(min_length=1, max_length=500)


class ExchangeIn(BaseModel):
    client_id: str
    client_secret: str
    code: str
    redirect_uri: str


@router.post("/authorize")
def authorize(body: AuthorizeIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return connect_service.authorize(db, user, body.client_id, body.redirect_uri, body.state)


@router.post("/token")
def token(body: ExchangeIn, db: Session = Depends(get_db)):
    return connect_service.exchange(db, body.client_id, body.client_secret, body.code, body.redirect_uri)
