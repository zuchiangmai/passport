// Print curl smoke checks for an already running local Worker with migrated D1.
// Console email generates and stores an OTP hash without exposing the code.
process.stdout.write(String.raw`BASE=http://127.0.0.1:8788

# All four return 200 and JSON.
curl -fsS "$BASE/healthz"
curl -fsS "$BASE/passport/healthz"
curl -fsS "$BASE/.well-known/oauth-authorization-server"
curl -fsS "$BASE/passport/.well-known/openid-configuration"

# Chinese sign-in page returns 200. Consent requires a signed OAuth request.
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/sign-in"
curl -sS -o /dev/null -w '%{http_code}\n' "$BASE/consent"

# Use a fresh test address or wait 60 seconds. Expect 202, then 429 across aliases.
curl -i "$BASE/v1/auth/passcode/request" -H 'Content-Type: application/json' -d '{"email":"smoke@example.test"}'
curl -i "$BASE/passport/v1/auth/passcode/request" -H 'Content-Type: application/json' -d '{"email":"smoke@example.test"}'

# Expect 400 invalid_email and 401 invalid_code (a different address with no OTP).
curl -i "$BASE/v1/auth/passcode/request" -H 'Content-Type: application/json' -d '{"email":"invalid"}'
curl -i "$BASE/v1/auth/passcode/verify" -H 'Content-Type: application/json' -d '{"email":"unissued@example.test","code":"000000"}'

# Both unauthorized requests return 401 without requiring any configured service secrets.
curl -i "$BASE/v1/identity/links" -H 'Content-Type: application/json' -d '{}'
curl -i "$BASE/v1/connect/token" -H 'Content-Type: application/json' -d '{}'

# The quiz page and endpoints do not exist unless QUIZ_REGISTRATION=on (404).
# With it on they need a session, so an anonymous request returns 401.
curl -i "$BASE/passport/api/auth/quiz/status"
`);
