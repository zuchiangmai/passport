# 食堂与 CoLiving 登录规则

`sub` 使用 Better Auth 的用户 ID。只有同一个 `sub` 已关联 CoLiving，才允许食堂登录或建立食堂关联。调用 `authorizeGate` 时，传入当前 `sub` 的关联记录。

`snapshot` 从 Better Auth 读取邮箱、邮箱验证状态和显示名称，并根据当前用户的关联计算 `apps` 和 `canteen_allowed`。`ensureLink` 使用 `schema.sql` 中的 D1 表，重复关联相同的外部 ID 时返回已有记录。`created_at` 使用 Unix 毫秒时间戳。

客户端密钥由调用方通过 `colivingSecret` 和 `canteenSecret` 提供。Worker 需启用 `nodejs_compat`，以使用 `node:crypto` 比较密钥。

Passkey 可选，由 Worker 分支上的 Better Auth passkey 插件负责。此模块只负责登录准入，WebAuthn 由插件实现。
