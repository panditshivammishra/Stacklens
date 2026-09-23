"""
─────────────────────────────────────────────────────────────────────────────
bootstrap.py — create an org, a user and a service, and print an API key.

Auth means a fresh install has a chicken-and-egg moment: you cannot send spans
without a key, and you cannot get a key without an account. This script does
that first-run setup from the command line so the demo works immediately.

Run (from backend-py/, with docker compose up):
    .venv\\Scripts\\python bootstrap.py
    .venv\\Scripts\\python bootstrap.py --email me@x.com --password secret123 \\
                                        --org "My Co" --service shop-api

It is safe to re-run: an existing account is reused, and only a fresh API key
is issued (keys cannot be re-read, so a new one is the only way to get one).
─────────────────────────────────────────────────────────────────────────────
"""
import argparse
import asyncio

from app.auth.crypto import hash_password, new_id
from app.db.postgres import close_db, execute, init_db, query
from app.routes.admin import issue_key, service_row_id


async def main(email: str, password: str, org_name: str, service_name: str) -> None:
    await init_db()          # also applies schema.sql, so the tables exist
    try:
        # ── org + user (reused if the email is already registered) ───────────
        existing = await query("SELECT id, org_id FROM users WHERE email = $1", email)
        if existing:
            user_id, org_id = existing[0]["id"], existing[0]["org_id"]
            print(f"Using existing account {email}")
        else:
            org_id, user_id = new_id(), new_id()
            await execute("INSERT INTO orgs (id, name) VALUES ($1, $2)", org_id, org_name)
            await execute(
                """INSERT INTO users (id, org_id, email, password_hash, role)
                   VALUES ($1, $2, $3, $4, 'owner')""",
                user_id, org_id, email, hash_password(password),
            )
            print(f"Created org '{org_name}' and user {email}")

        # ── service (id is namespaced by org — same scheme as routes/admin.py,
        #    imported rather than re-derived so the two can never drift) ──────
        service_id = service_row_id(org_id, service_name)
        if not await query("SELECT id FROM services WHERE id = $1", service_id):
            await execute(
                """INSERT INTO services (id, name, org_id, first_seen, last_seen)
                   VALUES ($1, $2, $3, NOW(), NOW())""",
                service_id, service_name, org_id,
            )
            print(f"Created service '{service_name}'")

        # ── a fresh key (the raw value exists only in this process) ──────────
        raw_key = await issue_key(org_id, service_id)

        print(
            f"\n{'=' * 68}\n"
            f"  Dashboard login : {email} / {password}\n"
            f"  Service         : {service_name}\n"
            f"  API KEY         : {raw_key}\n"
            f"{'=' * 68}\n"
            "  Copy the key into your SDK config - it is not stored anywhere\n"
            "  in readable form and cannot be shown again:\n\n"
            f"      stacklens({{ serviceId: '{service_name}',\n"
            f"                  apiKey: '{raw_key}',\n"
            # plain string, not an f-string, so a single brace is literal here
            "                  backendUrl: 'http://localhost:4001' })\n"
        )
    finally:
        await close_db()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description="First-run setup for Stacklens")
    p.add_argument("--email", default="demo@stacklens.dev")
    p.add_argument("--password", default="demo-password-123")
    p.add_argument("--org", default="Demo Org")
    p.add_argument("--service", default="shop-api")
    a = p.parse_args()
    asyncio.run(main(a.email, a.password, a.org, a.service))
