# passport

Community Account System, open source.

4Seas 生态的统一账户与资产层。对外地址是 `https://4seas.xyz/passport`（不是单独子域）。业务系统只认 Passport 的 `sub`，不各自发一套账号主键。

`sub` 是这个人在 Passport 里的固定编号，等于 `users.id`。换邮箱、换 Google、换 GitHub 都不变。CoLiving 和食堂各自的库只存这一列，用来认出同一个人。通行密钥不是登录条件，可以以后再加。

食堂只放行已经挂上 CoLiving 注册的 `sub`。没有 CoLiving 链接时，授权接口返回 `403 canteen_requires_coliving`。

| 谁 | 做什么 |
| --- | --- |
| 浏览器 | 打开 `/passport/login?client_id&redirect_uri&state`，邮箱验证码、Google 或 GitHub |
| CoLiving | 服务密钥 `identity:write` 把已验证邮箱和自己的外部 id 绑到 `sub`；用 `client_id=coliving` 换 token |
| 食堂 | 只接受 `client_id=canteen` 的授权码。回调只允许 `https://4seas.xyz/canteen/auth/callback` 和当前的 workers.dev 回调 |

原有的邮箱 magic link、Telegram、积分、签到、webhook 都还在 `/v1/...`，同一套路由也挂在 `/passport/v1/...`。

接口需求文档(由 CommunityOS 项目提出):见 4Seas-CommunityOS 仓库 docs/06-community-account-system.md。

## 功能

| 模块 | 端点 | 说明 |
| --- | --- | --- |
| 账户 | POST /v1/auth/register, /verify-email, /login/request, /login/verify, /passcode/request, /passcode/verify, /logout | 邮箱注册;magic link;6 位验证码。JWT 的 `sub` 就是这个人的编号 |
| 登录页 | GET /passport/login | 给 CoLiving / 食堂跳转用。带 client_id、redirect_uri、state |
| 合并登录 | POST /v1/connect/authorize, /v1/connect/token | 授权码交给 coliving 或 canteen。食堂要求已有 CoLiving 链接 |
| 身份链接 | POST /v1/identity/links; GET /v1/identity/{sub} | 服务密钥。`identity:write` / `identity:read` |
| Google / GitHub | GET /v1/auth/google/start, /github/start 及 callback | 已验证邮箱并入同一个 sub。未配置时 start 返回 422 |
| 我的 | GET/PATCH /v1/me; POST/DELETE /v1/me/telegram | 资料;Telegram initData 官方算法验签绑定 |
| 服务密钥 | POST/DELETE /v1/service-keys | Admin key 管理;secret 仅返回一次,库中只存 SHA-256;按 scope 鉴权 |
| 用户 | GET /v1/users/{id} | scope: users:read |
| 积分 | GET /v1/users/{id}/points; POST .../points/adjust; GET /v1/points/ledger | append-only 流水;余额 = sum(delta);扣减不足返回 422;seq 游标分页 |
| 签到 | POST /v1/checkin/tokens, /claim; GET /tokens/{id}; POST /tokens/{id}/nft-claim | 一次性 claim_url(event_url + ck + sig);重放 409、过期 410、坏签名 401 |
| Webhooks | POST /v1/webhooks/subscriptions | CAS 到业务系统推送(user.verified / user.updated / points.changed / telegram.bound),X-CAS-Signature = HMAC-SHA256(secret, body),指数退避重试 |
| 运维 | GET /healthz; /docs | OpenAPI 文档 |

安全要点:token/密钥不明文落库;所有账户、积分、签到、密钥变更写 audit_logs。

## Quickstart(本地)

    git clone git@github.com:4seas-community/Community-Account-System.git
    cd Community-Account-System
    python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
    cp .env.example .env
    .venv/bin/alembic upgrade head
    .venv/bin/uvicorn app.main:app --reload --port 8000

开发默认 SQLite;生产用 PostgreSQL:DATABASE_URL=postgresql+psycopg://user:pass@host:5432/cas。

邮件默认 console 后端(验证链接打进日志);生产设置 EMAIL_BACKEND=smtp 并配置 SMTP_*。

Telegram 绑定需要设置 TELEGRAM_BOT_TOKEN(与 4Seas Bot 同一个 bot);为空时仅限本地开发。

## Docker

    docker compose up --build
    # API: http://localhost:8000  文档: http://localhost:8000/docs

## 测试

    .venv/bin/pytest -q      # 23 个测试:认证全流程、token 一次性/过期、Telegram 验签、
                             # service key scope/吊销、积分扣减与流水、签到重放/过期/坏签名、webhook 签名
    .venv/bin/ruff check .   # lint

## 目录结构

    app/
      main.py            FastAPI 入口、统一错误格式
      config.py          pydantic-settings 配置
      db.py              SQLAlchemy engine/session/Base
      security.py        token 哈希、JWT、HMAC 签名、naive-UTC 时间
      models.py          users / tokens / service_keys / points_entries / checkin_tokens /
                         webhook_subscriptions / webhook_deliveries / audit_logs
      schemas.py         Pydantic 模型
      deps.py            用户态 / 服务态 / admin 认证依赖
      audit.py           审计写入
      email_backend.py   console / smtp
      api/               路由(auth, me, service_keys, users, points, checkin, webhooks)
      services/          auth_service, points_service, checkin_service, telegram, webhook_service
    alembic/             迁移
    tests/               pytest 套件

## Roadmap

- M1(已交付):账户 + service keys + 积分账本 + 签到令牌 + webhooks + Docker
- V2:链上积分(SIWE 钱包绑定、链上权威同步)、NFT claim 对接外部 NFT 系统、多账本

详见 4Seas-CommunityOS docs/06 与 docs/07。

## License

Apache-2.0
