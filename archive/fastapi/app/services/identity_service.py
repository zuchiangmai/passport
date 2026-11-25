"""Passport sub is users.id. CoLiving and the canteen store that, not an email."""

from sqlalchemy.orm import Session

from .. import audit as audit_mod
from ..errors import CanteenRequiresColiving, Conflict, NotFound
from ..models import AppLink, User
from ..security import new_id, utcnow
from .auth_service import get_user_by_email

APPS = ("coliving", "canteen")


def links_for(db: Session, user_id: str) -> list[AppLink]:
    return db.query(AppLink).filter(AppLink.user_id == user_id).order_by(AppLink.app).all()


def has_coliving(db: Session, user_id: str) -> bool:
    return (
        db.query(AppLink)
        .filter(AppLink.user_id == user_id, AppLink.app == "coliving")
        .one_or_none()
        is not None
    )


def snapshot(db: Session, user: User) -> dict:
    apps = [row.app for row in links_for(db, user.id)]
    return {
        "sub": user.id,
        "email": user.email,
        "email_verified": bool(user.verified),
        "display_name": user.display_name,
        "apps": apps,
        "canteen_allowed": "coliving" in apps,
    }


def link_app(
    db: Session,
    *,
    app: str,
    email: str,
    external_id: str,
    display_name: str | None = None,
) -> dict:
    if app not in APPS:
        raise NotFound("unknown app")
    email = email.lower().strip()
    external_id = external_id.strip()
    if not external_id:
        raise NotFound("external_id required")

    user = get_user_by_email(db, email)
    if app == "canteen" and (not user or not has_coliving(db, user.id)):
        raise CanteenRequiresColiving("canteen requires a CoLiving registration")
    if not user:
        user = User(id=new_id(), email=email, verified=True, display_name=display_name, created_at=utcnow(), updated_at=utcnow())
        db.add(user)
        db.flush()
    elif display_name and not user.display_name:
        user.display_name = display_name
    if app == "coliving":
        user.verified = True

    taken = (
        db.query(AppLink)
        .filter(AppLink.app == app, AppLink.external_id == external_id)
        .one_or_none()
    )
    if taken and taken.user_id != user.id:
        raise Conflict("external id already linked to another sub")

    row = db.query(AppLink).filter(AppLink.user_id == user.id, AppLink.app == app).one_or_none()
    if row and row.external_id != external_id:
        raise Conflict("this sub is already linked to another id in that app")
    if not row:
        row = AppLink(id=new_id(), user_id=user.id, app=app, external_id=external_id, created_at=utcnow())
        db.add(row)
    audit_mod.audit(db, "service", None, "identity.link", {"sub": user.id, "app": app, "external_id": external_id})
    db.commit()
    db.refresh(user)
    return snapshot(db, user)
