from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./cas.db"
    jwt_secret: str = "dev-secret"
    jwt_algorithm: str = "HS256"
    checkin_secret: str = "dev-checkin-secret"
    admin_key: str = "dev-admin-key"

    access_token_ttl_minutes: int = 60
    verify_token_ttl_hours: int = 24
    login_token_ttl_minutes: int = 15

    email_backend: str = "console"  # console | smtp
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    email_from: str = "no-reply@4seas.example"

    telegram_bot_token: str = ""

    public_base_url: str = "https://4seas.xyz"
    # development | production. Production refuses an empty secret and the values that used to be in source.
    environment: str = "development"
    coliving_client_secret: str = ""
    canteen_client_secret: str = ""
    passcode_ttl_minutes: int = 10
    auth_code_ttl_minutes: int = 5

    google_client_id: str = ""
    google_client_secret: str = ""
    github_client_id: str = ""
    github_client_secret: str = ""

    webhook_timeout_seconds: int = 5
    webhook_max_attempts: int = 3


# These strings shipped in the repo. A production process must not accept them.
PUBLISHED_CLIENT_SECRETS = frozenset({"dev-coliving-secret", "dev-canteen-secret"})


def assert_client_secrets(settings: Settings | None = None) -> None:
    """Fail closed in production when a connect client secret was left unset or published."""
    settings = settings or get_settings()
    if settings.environment != "production":
        return
    for name in ("coliving_client_secret", "canteen_client_secret"):
        value = getattr(settings, name)
        if not value or value in PUBLISHED_CLIENT_SECRETS or value.startswith("change-me"):
            raise RuntimeError(f"{name} must be a private value when environment=production")


@lru_cache
def get_settings() -> Settings:
    return Settings()
